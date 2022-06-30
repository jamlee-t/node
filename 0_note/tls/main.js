// How To Use The TLS Module
// https://nodejs.org/en/knowledge/cryptography/how-to-use-the-tls-module/

// openssl req -new -SHA256 -newkey rsa:2048 -nodes -keyout localhost.key -out localhost.csr -subj "/C=CN/ST=Shanghai/L=Shanghai/O=/OU=/CN=localhost"
// openssl x509 -req -days 365 -in localhost.csr -signkey localhost.key -out localhost.crt

var tls = require('tls'),
    fs = require('fs'),
    msg = [
        ".-..-..-.  .-.   .-. .--. .---. .-.   .---. .-.",
        ": :; :: :  : :.-.: :: ,. :: .; :: :   : .  :: :",
        ":    :: :  : :: :: :: :: ::   .': :   : :: :: :",
        ": :: :: :  : `' `' ;: :; :: :.`.: :__ : :; ::_;",
        ":_;:_;:_;   `.,`.,' `.__.':_;:_;:___.':___.':_;"
    ].join("\n");
var options = {
    key: fs.readFileSync('./localhost.key', 'utf8'),
    cert: fs.readFileSync('./localhost.crt', 'utf8'),

    ca: [ fs.readFileSync('./localhost.crt') ],
};
// console.log(options);
tls.createServer(options, function (s) {
    s.write(msg + "\n");
    s.pipe(s);
}).listen(8000, () => {
    var conn = tls.connect(8000, options, function () {
        if (conn.authorized) {
            console.log("Connection authorized by a Certificate Authority.");
        } else {
            console.log("Connection not authorized: " + conn.authorizationError)
        }
        console.log();
    });
    conn.on("data", function (data) {
        console.log(data.toString());
        conn.end();
    });
});
