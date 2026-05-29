// Simulate Meta webhook verification through the tunnel
// Uses Facebook-like User-Agent to test if localtunnel bypasses the warning
const https = require('https');

const url = 'https://malika-wa.loca.lt/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=TEST_FROM_NODE_42';

console.log('Testing:', url);

https.get(url, { headers: {
  'User-Agent': 'facebookplatform/1.0 (+http://developers.facebook.com)',
  'Accept': '*/*'
}}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Body length:', body.length);
    console.log('Body (first 300 chars):', body.slice(0, 300));
    console.log('---');
    console.log('Expected body: TEST_FROM_NODE_42');
    console.log('Match:', body.trim() === 'TEST_FROM_NODE_42');
  });
}).on('error', e => {
  console.error('Error:', e.message);
});
