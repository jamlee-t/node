const http = require('http');

const requestListener = function (req, res) {
    req.pause();
    req.on("data", () => {
        res.writeHead(200);
        res.end('Hello, World! \n');
    });
}
const server = http.createServer(requestListener);
server.listen(8080);