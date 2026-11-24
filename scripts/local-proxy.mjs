// Local no-auth forward proxy for browser testing on this VM.
//
// The VM reaches the internet through an authenticated egress proxy
// (HTTPS_PROXY). Chromium cannot authenticate to it: credentials embedded in
// --proxy-server are ignored, and Playwright's proxy-auth handling fails the
// CONNECT tunnel (ERR_TUNNEL_CONNECTION_FAILED). This tiny proxy listens on
// 127.0.0.1 only, accepts unauthenticated requests from the local browser,
// and forwards them upstream with Proxy-Authorization added.
//
// Usage: node scripts/local-proxy.mjs [port, default 8888]
// Then point the browser at http://127.0.0.1:8888 (no auth).
// Credentials come from HTTPS_PROXY and are never printed or logged.
import net from "node:net";
import http from "node:http";

const PORT = Number(process.argv[2] || 8888);
const upstream = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || "");
if (!upstream.hostname) {
  console.error("No HTTPS_PROXY in the environment; nothing to forward to.");
  process.exit(1);
}
const auth =
  "Basic " +
  Buffer.from(
    `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
  ).toString("base64");
const UP_HOST = upstream.hostname;
const UP_PORT = Number(upstream.port) || 3128;

function handleConnect(req, clientSocket, head) {
  const target = req.url; // "host:port"
  const upstreamSocket = net.connect(UP_PORT, UP_HOST, () => {
    upstreamSocket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
  });
  let headerBuf = Buffer.alloc(0);
  let established = false;
  upstreamSocket.on("data", (chunk) => {
    if (established) return; // piped below
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const end = headerBuf.indexOf("\r\n\r\n");
    if (end === -1) return;
    const headText = headerBuf.subarray(0, end).toString("latin1");
    const rest = headerBuf.subarray(end + 4);
    if (!/^HTTP\/\d\.\d 200/.test(headText)) {
      console.error(`upstream CONNECT ${target} refused: ${headText.split("\r\n")[0]}`);
      clientSocket.destroy();
      upstreamSocket.destroy();
      return;
    }
    established = true;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length) upstreamSocket.unshift(rest);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  const onErr = (err) => {
    if (!established) console.error(`CONNECT ${target} error: ${err.message}`);
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  upstreamSocket.on("error", onErr);
  clientSocket.on("error", onErr);
}

function handleRequest(req, res) {
  // Plain HTTP via proxy: absolute-form URL. Forward with auth added.
  const upstreamSocket = net.connect(UP_PORT, UP_HOST, () => {
    const headers = { ...req.headers, host: req.headers.host, "proxy-authorization": auth };
    delete headers["proxy-connection"];
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
    req.pipe(upstreamSocket);
  });
  upstreamSocket.on("data", (chunk) => res.socket?.write(chunk));
  upstreamSocket.on("error", (err) => {
    console.error(`request ${req.url} error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("error", () => upstreamSocket.destroy());
}

const server = http.createServer(handleRequest);
server.on("connect", handleConnect);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`local forward proxy listening on 127.0.0.1:${PORT} -> ${UP_HOST}:${UP_PORT}`);
});
