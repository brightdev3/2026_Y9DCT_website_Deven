// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Jimp, loadFont } = require('jimp');
const { SANS_32_BLACK } = require('jimp/fonts');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

async function createButtonImage(text) {
    const image = new Jimp({
        width: 200,
        height: 50,
        color: 0xffffffff
    });

    // v1: loadFont is a named export, not Jimp.loadFont
    const font = await loadFont(SANS_32_BLACK);

    // v1: print takes an options object
    image.print({
        font,
        x: 10,
        y: 5,
        text,
        maxWidth: 180
    });

    return image;
}

async function serveButton(url, res) {
    const text = url.searchParams.get('text') ?? 'Button';
    try {
        const image = await createButtonImage(text);
        const buffer = await image.getBuffer('image/png');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buffer.length,
            'Cache-Control': 'no-store'
        });
        res.end(buffer);
    } catch (err) {
        console.error('button render failed:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to render button');
    }
}

function serveStatic(pathname, res) {
    const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
            res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/button') {
        return serveButton(url, res);
    }

    // /page -> /page.html, /foo/bar -> /foo/bar.html (only when no extension)
    if (!path.extname(pathname)) {
        pathname = pathname.endsWith('/')
            ? pathname + 'index.html'
            : pathname + '.html';
    }

    serveStatic(pathname, res);
});

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});