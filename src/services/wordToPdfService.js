import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const WORD_MIME_TYPES = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

const CONVERSION_TIMEOUT_MS = 120000;

function isWordFile(mimeType, filename = '') {
  if (mimeType && WORD_MIME_TYPES.includes(mimeType)) return true;
  if (filename && /\.docx?$/i.test(filename)) return true;
  return false;
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // best-effort cleanup
  }
}

/**
 * Convert a .doc/.docx file to PDF using headless LibreOffice.
 * Each conversion runs in its own UserInstallation profile so concurrent
 * conversions do not collide on the shared default profile.
 *
 * @param {string} inputPath Absolute path to the .doc/.docx file
 * @returns {Promise<{ pdfPath: string, workDir: string }>}
 *   workDir must be passed to cleanupDir() once the PDF has been consumed.
 */
function convertToPdf(inputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Input file does not exist: ${inputPath}`));
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2p-'));
    const profileDir = path.join(workDir, 'profile');

    const args = [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', workDir,
      inputPath
    ];

    const child = spawn('soffice', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      cleanupDir(workDir);
      reject(new Error(`LibreOffice conversion timed out after ${CONVERSION_TIMEOUT_MS}ms`));
    }, CONVERSION_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timeout);
      cleanupDir(workDir);
      reject(new Error(`Failed to spawn soffice: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        cleanupDir(workDir);
        return reject(new Error(
          `LibreOffice exited with code ${code}. stderr: ${stderr.trim() || '(empty)'} stdout: ${stdout.trim() || '(empty)'}`
        ));
      }

      const inputBasename = path.basename(inputPath, path.extname(inputPath));
      const pdfPath = path.join(workDir, `${inputBasename}.pdf`);

      if (!fs.existsSync(pdfPath)) {
        cleanupDir(workDir);
        return reject(new Error(
          `LibreOffice reported success but PDF not found at ${pdfPath}. stdout: ${stdout.trim()}`
        ));
      }

      resolve({ pdfPath, workDir });
    });
  });
}

export const wordToPdfService = {
  isWordFile,
  convertToPdf,
  cleanupDir
};
