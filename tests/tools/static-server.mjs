#!/usr/bin/env node
/**
 * The static file server of the browser tests.
 *
 *   node tools/static-server.mjs <directory> <port> <serve.json>
 *
 * It answers as `npx serve <directory> -p <port> -c <serve.json>` does: the same
 * file handler (serve-handler), ETags, the same compression, the headers of
 * serve.json. The one difference is the reason it exists: it closes a file when
 * the response it was opened for is over.
 *
 * `serve` opens the file before it knows what it will answer and never closes
 * it itself, so the file stays open for good
 *   - when the answer is "304 Not Modified" (the file is then not read at all), and
 *   - when a download is cut off half way (the page was closed).
 * Every worker thread of a page asks for the page's script again and gets a 304:
 * about 30 files left open per test on a 10 core machine, more with more cores.
 * A run of every project then passed the 65536 open files a CI runner allows.
 * The server died with EMFILE ("too many open files") and every test after it
 * failed with "connection refused".
 */
import { createReadStream, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import compression from 'compression';
import handler from 'serve-handler';

const [directory, portArg, configFile] = process.argv.slice(2);
const port = Number(portArg);
if (!directory || !configFile || !Number.isInteger(port) || port <= 0) {
  console.error('usage: static-server.mjs <directory> <port> <serve.json>');
  process.exit(2);
}

const config = {
  ...JSON.parse(readFileSync(configFile, 'utf8')),
  public: path.resolve(directory),
  etag: true,
};
const compress = compression();

const server = http.createServer((request, response) => {
  const methods = {
    createReadStream(file, options) {
      const stream = createReadStream(file, options);
      // Without options the handler reads the file to the end for its ETag, once per
      // file: that read closes the file itself, and is worth finishing in any case.
      if (options === undefined) return stream;
      // The file of the answer. Sent, cut off, or never read: it is closed when the
      // response is over.
      if (response.destroyed) stream.destroy();
      else response.once('close', () => stream.destroy());
      // A file that cannot be read fails its own request, not the server.
      stream.on('error', (error) => {
        console.error(`static-server: ${file}: ${error.message}`);
        response.destroy();
      });
      return stream;
    },
  };
  compress(request, response, () => {
    handler(request, response, config, methods).catch((error) => {
      console.error(`static-server: ${request.url}: ${error?.message ?? error}`);
      response.destroy();
    });
  });
});

server.on('error', (error) => {
  console.error(`static-server: ${error.message}`);
  process.exit(1);
});
server.listen(port);
