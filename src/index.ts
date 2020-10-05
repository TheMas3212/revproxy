
import * as jsonfile from 'jsonfile';
import * as fs from 'fs';
import * as cluster from 'cluster';
import { cpus } from 'os';

import * as http from 'http';
import * as https from 'https';
import * as express from 'express';
import * as proxy from 'http-proxy';

const HTTPS_ENABLED = !(process.env.DISABLE_HTTPS === 'true');
const DEFAULT_ROUTE = process.env.DEFAULT_ROUTE || "http://pihole/";
const HTTPSKEY = process.env.HTTPSKEY || "/run/secrets/privkey";
const HTTPSCERT = process.env.HTTPSCERT || "/run/secrets/fullchain";

if (cluster.isMaster) {
  const numCPUs = cpus().length;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
  });
  process.on('SIGINT', () => {
    for (const worker in cluster.workers) {
      cluster.worker[worker].kill();
    }
    process.exit();
  });
} else {
  process.on('SIGINT', () => {
    httpserver.close();
    if (httpsserver) {
      httpsserver.close();
    }
  });


  const app: express.Application = express();
  const httpserver: http.Server = http.createServer(app);
  let httpsserver: https.Server;

  if (HTTPS_ENABLED) {
    const httpsOptions: https.ServerOptions = {
      cert: fs.readFileSync(HTTPSCERT),
      key: fs.readFileSync(HTTPSKEY),
      requestCert: true,
      rejectUnauthorized: false,
    };
    httpsserver = https.createServer(httpsOptions, app);
  }

  app.disable("x-powered-by");
  const mapping: Map<string,any> = new Map();
  let defaultProxy;
  if (DEFAULT_ROUTE !== 'none') {
    defaultProxy = proxy.createProxy({ target: DEFAULT_ROUTE, xfwd: true });
  } else {
    defaultProxy = {
      "web": (req, res) => {
        res.send("Proxy Online");
      }
    };
  }
  

  for (const item of jsonfile.readFileSync(process.env.MAPPING)) {
    const mapitem: any = {};
    if (item.httpauth) {
      mapitem.proxy = proxy.createProxy({ target: item.real, ws: true, xfwd: true, auth: item.httpauth });
      console.log(`[${cluster.worker.id}] Loaded Route: ${item.host} > ${item.real} with Basic HttpAuth`);
    } else {
      mapitem.proxy = proxy.createProxy({ target: item.real, ws: true, xfwd: true });
      console.log(`[${cluster.worker.id}] Loaded Route: ${item.host} > ${item.real}`);
    }
    mapping.set(item.host, mapitem);
  }

  function proxyWeb(req: express.Request, res: express.Response, next: express.NextFunction) {
    for (const [host, mapitem] of mapping) {
      if (req.hostname === host) {
        mapitem.proxy.web(req, res);
        return;
      } else if (host.startsWith('*') && req.hostname.endsWith(host)) {
        mapitem.proxy.web(req, res);
        return;
      }
    }
    defaultProxy.web(req, res);
    return;
  }

  function proxyWS(req: http.IncomingMessage, socket, head) {
    const hostname = req.headers.host.split(":", 1)[0];
    for (const [host, mapitem] of mapping) {
      if (hostname === host) {
        mapitem.proxy.ws(req, socket, head);
        return;
      } else if (host.startsWith('*') && hostname.endsWith(host)) {
        mapitem.proxy.ws(req, socket, head);
        return;
      }
    }
    socket.destroy();
  }

  app.all('*', proxyWeb);
  httpserver.on("upgrade", proxyWS);
  if (HTTPS_ENABLED) httpsserver.on('upgrade', proxyWS);

  httpserver.listen(8080);
  if (HTTPS_ENABLED) httpsserver.listen(8443);
}


