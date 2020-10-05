
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
  const mapping = new Map();
  const defaultroute = proxy.createProxy({ target: DEFAULT_ROUTE, xfwd: true });

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

  app.all('*', (req, res, next) => {
    if (mapping.has(req.hostname)) {
      const mapitem = mapping.get(req.hostname);
      mapitem.proxy.web(req, res);
    } else {
      defaultroute.web(req, res);
    }
  });
  httpserver.on("upgrade", (req: http.IncomingMessage, socket, head) => {
    const hostname = req.headers.host.split(":", 1)[0];
    if (mapping.has(hostname)) {
      mapping.get(hostname).proxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  if (HTTPS_ENABLED) {
    httpsserver.on("upgrade", (req: http.IncomingMessage, socket, head) => {
      const hostname = req.headers.host.split(":", 1)[0];
      if (mapping.has(hostname)) {
        mapping.get(hostname).proxy.ws(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  httpserver.listen(8080);
  if (HTTPS_ENABLED) httpsserver.listen(8443);
}


