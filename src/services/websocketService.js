import { WebSocketServer } from 'ws';
import pg from 'pg';
import { config } from '../config.js';
import { QueueService } from '../db/queueService.js';

const { Client } = pg;

class WebSocketService {
  constructor() {
    this.wss = null;
    this.pgClient = null;
    this.subscriptions = new Map(); // jobId -> Set<WebSocket>
    this.chartSubscriptions = new Map(); // sessionId -> Set<WebSocket>
    this.pingInterval = null;
    this.pgKeepAliveInterval = null;
    this._reconnecting = false;
  }

  /**
   * Initialize WebSocket server attached to existing HTTP server
   * and start listening for PostgreSQL NOTIFY events
   */
  async init(server) {
    // Create WebSocket server on /api/ws path (so Nginx's /api proxy handles it)
    this.wss = new WebSocketServer({ server, path: '/api/ws' });

    this.wss.on('connection', (ws) => {
      console.log('🔌 WebSocket client connected');

      ws.isAlive = true;
      ws.subscribedJobs = new Set();
      ws.subscribedCharts = new Set();

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data) => {
        this._handleMessage(ws, data);
      });

      ws.on('close', () => {
        this._cleanupClient(ws);
        console.log('🔌 WebSocket client disconnected');
      });

      ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
        this._cleanupClient(ws);
      });
    });

    // Ping clients every 30s to detect dead connections
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          this._cleanupClient(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(this.pingInterval);
    });

    // Start listening to PostgreSQL notifications
    await this._startPGListener();

    console.log('📡 WebSocket server ready on /api/ws');
  }

  /**
   * Handle incoming WebSocket messages
   */
  _handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'subscribe' && msg.jobId) {
        // Add client to subscription map
        if (!this.subscriptions.has(msg.jobId)) {
          this.subscriptions.set(msg.jobId, new Set());
        }
        this.subscriptions.get(msg.jobId).add(ws);
        ws.subscribedJobs.add(msg.jobId);

        ws.send(JSON.stringify({
          type: 'subscribed',
          jobId: msg.jobId,
          timestamp: new Date().toISOString()
        }));

        // Send current job status immediately so client knows where things stand
        this._sendCurrentStatus(ws, msg.jobId);

      } else if (msg.type === 'unsubscribe' && msg.jobId) {
        this._unsubscribeJob(ws, msg.jobId);

        ws.send(JSON.stringify({
          type: 'unsubscribed',
          jobId: msg.jobId,
          timestamp: new Date().toISOString()
        }));

      } else if (msg.type === 'subscribe_charts' && Array.isArray(msg.sessionIds)) {
        // Dashboard subscribes to chart-level status updates
        console.log(`📊 [WS] subscribe_charts — ${msg.sessionIds.length} sessionIds:`, msg.sessionIds.slice(0, 5), msg.sessionIds.length > 5 ? '...' : '');
        for (const sid of msg.sessionIds) {
          const key = String(sid);
          if (!this.chartSubscriptions.has(key)) {
            this.chartSubscriptions.set(key, new Set());
          }
          this.chartSubscriptions.get(key).add(ws);
          ws.subscribedCharts.add(key);
        }
        ws.send(JSON.stringify({
          type: 'charts_subscribed',
          count: msg.sessionIds.length,
          timestamp: new Date().toISOString()
        }));

      } else if (msg.type === 'unsubscribe_charts') {
        this._unsubscribeAllCharts(ws);
        ws.send(JSON.stringify({
          type: 'charts_unsubscribed',
          timestamp: new Date().toISOString()
        }));
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format.'
      }));
    }
  }

  /**
   * Fetch current job status from DB and send to client immediately on subscribe
   */
  async _sendCurrentStatus(ws, jobId) {
    try {
      const job = await QueueService.getJob(jobId);
      if (!job) {
        ws.send(JSON.stringify({
          type: 'status_update',
          jobId,
          status: 'not_found',
          phase: 'not_found',
          message: 'Job not found',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      ws.send(JSON.stringify({
        type: 'status_update',
        jobId,
        status: job.status,
        phase: job.current_phase || job.status,
        message: job.status === 'completed'
          ? 'Job already completed'
          : job.status === 'failed'
            ? `Job failed: ${job.error_message || 'Unknown error'}`
            : `Job is ${job.status}`,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      console.error('❌ Error fetching current job status:', err.message);
    }
  }

  /**
   * Remove a client's subscription for a specific job
   */
  _unsubscribeJob(ws, jobId) {
    const clients = this.subscriptions.get(jobId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.subscriptions.delete(jobId);
      }
    }
    ws.subscribedJobs.delete(jobId);
  }

  /**
   * Remove all chart subscriptions for a client
   */
  _unsubscribeAllCharts(ws) {
    if (ws.subscribedCharts) {
      for (const sid of ws.subscribedCharts) {
        const clients = this.chartSubscriptions.get(sid);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) this.chartSubscriptions.delete(sid);
        }
      }
      ws.subscribedCharts.clear();
    }
  }

  /**
   * Clean up all subscriptions for a disconnected client
   */
  _cleanupClient(ws) {
    if (ws.subscribedJobs) {
      for (const jobId of ws.subscribedJobs) {
        this._unsubscribeJob(ws, jobId);
      }
    }
    this._unsubscribeAllCharts(ws);
  }

  /**
   * Connect a dedicated PG client and LISTEN on job_status_update channel.
   * Uses TCP keepalive + periodic heartbeat to prevent idle disconnects.
   */
  async _startPGListener() {
    // Clear any existing keepalive interval
    if (this.pgKeepAliveInterval) {
      clearInterval(this.pgKeepAliveInterval);
      this.pgKeepAliveInterval = null;
    }

    this.pgClient = new Client({
      connectionString: config.database.url,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // TCP keepalive to prevent firewalls/LBs from killing idle connections
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    this.pgClient.on('error', (err) => {
      console.error('❌ WebSocket PG listener error:', err.message);
      this._reconnectPGListener();
    });

    await this.pgClient.connect();
    await this.pgClient.query('LISTEN job_status_update');
    await this.pgClient.query('LISTEN chart_status_update');

    this.pgClient.on('notification', (msg) => {
      if (msg.channel === 'job_status_update') {
        this._handleNotification(msg.payload);
      } else if (msg.channel === 'chart_status_update') {
        this._handleChartNotification(msg.payload);
      }
    });

    // Send a lightweight query every 30s to keep the connection alive
    this.pgKeepAliveInterval = setInterval(async () => {
      try {
        await this.pgClient.query('SELECT 1');
      } catch (err) {
        console.error('❌ PG keepalive query failed:', err.message);
        this._reconnectPGListener();
      }
    }, 30000);

    console.log('👂 PG LISTEN active on channels: job_status_update, chart_status_update (keepalive enabled)');
  }

  /**
   * Reconnect the PG listener if connection drops.
   * Uses a guard to prevent multiple concurrent reconnect attempts.
   */
  async _reconnectPGListener() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    // Stop the keepalive heartbeat for the dead connection
    if (this.pgKeepAliveInterval) {
      clearInterval(this.pgKeepAliveInterval);
      this.pgKeepAliveInterval = null;
    }

    try {
      if (this.pgClient) {
        try { await this.pgClient.end(); } catch (e) { /* ignore */ }
        this.pgClient = null;
      }
      await this._startPGListener();
      console.log('🔄 PG listener reconnected successfully');
    } catch (err) {
      console.error('❌ PG listener reconnect failed:', err.message);
      setTimeout(() => {
        this._reconnecting = false;
        this._reconnectPGListener();
      }, 5000);
      return;
    }
    this._reconnecting = false;
  }

  /**
   * Handle a NOTIFY payload and push to subscribed WebSocket clients
   */
  _handleNotification(payload) {
    try {
      const update = JSON.parse(payload);
      const { jobId } = update;

      const clients = this.subscriptions.get(jobId);
      if (!clients || clients.size === 0) return;

      const message = JSON.stringify({ type: 'status_update', ...update });

      for (const ws of clients) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(message);
        }
      }
    } catch (err) {
      console.error('❌ Error handling PG notification:', err.message);
    }
  }

  /**
   * Handle a chart_status_update NOTIFY and push to subscribed dashboard clients
   */
  _handleChartNotification(payload) {
    try {
      const update = JSON.parse(payload);
      const { sessionId } = update;

      console.log(`📊 [WS] chart_status_update received from PG — sessionId: ${sessionId}, aiStatus: ${update.aiStatus}`);
      console.log(`📊 [WS] chartSubscriptions has key "${String(sessionId)}": ${this.chartSubscriptions.has(String(sessionId))}`);
      console.log(`📊 [WS] Total chartSubscription keys:`, [...this.chartSubscriptions.keys()].slice(0, 10));

      const clients = this.chartSubscriptions.get(String(sessionId));
      if (!clients || clients.size === 0) {
        console.log(`📊 [WS] No subscribed clients for sessionId: ${sessionId}`);
        return;
      }

      console.log(`📊 [WS] Forwarding to ${clients.size} client(s)`);
      const message = JSON.stringify({ type: 'chart_status_update', ...update });

      for (const ws of clients) {
        if (ws.readyState === 1) {
          ws.send(message);
        }
      }
    } catch (err) {
      console.error('❌ Error handling chart notification:', err.message);
    }
  }

  /**
   * Broadcast chart status directly to subscribed WebSocket clients (no PG NOTIFY).
   * Use this from code running in the same process (e.g., documentController).
   */
  broadcastChartStatus(sessionId, aiStatus) {
    const update = {
      sessionId: String(sessionId),
      aiStatus,
      timestamp: new Date().toISOString()
    };
    console.log(`📊 [WS] broadcastChartStatus direct — sessionId: ${sessionId}, aiStatus: ${aiStatus}`);
    this._handleChartNotification(JSON.stringify(update));
  }

  /**
   * Graceful shutdown
   */
  async close() {
    clearInterval(this.pingInterval);
    if (this.pgKeepAliveInterval) {
      clearInterval(this.pgKeepAliveInterval);
    }

    if (this.wss) {
      this.wss.clients.forEach((ws) => ws.terminate());
      this.wss.close();
    }

    if (this.pgClient) {
      try { await this.pgClient.end(); } catch (e) { /* ignore */ }
    }
  }
}

export const websocketService = new WebSocketService();
export default websocketService;
