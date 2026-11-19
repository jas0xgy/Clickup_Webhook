require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

// One-time Google sign-in that stores GMAIL_REFRESH_TOKEN in .env for the health email.
const port = Number(process.env.GMAIL_AUTH_PORT || 53682);
const redirectUri = `http://localhost:${port}/oauth2callback`;
const envPath = path.join(__dirname, '..', '.env');
const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, SMTP_USER: user } = process.env;

function saveRefreshToken(token) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `GMAIL_REFRESH_TOKEN=${token}`;
  const updated = /^GMAIL_REFRESH_TOKEN=.*$/m.test(text) ?
    text.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, line) : `${text.replace(/\s*$/, '')}\r\n${line}\r\n`;
  fs.writeFileSync(envPath, updated);
}

if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
  scope: 'https://mail.google.com/', access_type: 'offline', prompt: 'consent', state,
  ...(user ? { login_hint: user } : {})
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
  const finish = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' }).end(message);
    console.log(message);
    server.close();
    if (status !== 200) process.exitCode = 1;
  };
  if (url.searchParams.get('state') !== state) return finish(400, 'Sign-in failed: state mismatch. Run npm run gmail:auth again.');
  if (url.searchParams.get('error')) return finish(400, `Sign-in failed: ${url.searchParams.get('error')}`);
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    }));
    if (!data.refresh_token) return finish(400, 'Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run npm run gmail:auth again.');
    saveRefreshToken(data.refresh_token);
    finish(200, 'Success: GMAIL_REFRESH_TOKEN saved to .env. You can close this tab and run npm run health:email.');
  } catch (error) {
    finish(500, `Token exchange failed: ${error.response?.data?.error_description || error.response?.data?.error || error.message}`);
  }
});

server.listen(port, () => {
  console.log(`Open this URL and sign in as ${user || 'the sending Gmail account'}:\n\n${authUrl}\n`);
  if (process.platform === 'win32') exec(`start "" "${authUrl}"`);
});
