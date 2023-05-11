# websocket-reverse-proxy
Reverse-proxy server and client to organize access to a private server through requests to a public server.
Basically does the same thing as [ngrock](https://ngrok.com/), but the server rises on your public server.

# Designations
- `Public server` - is usually a server accessible from the global Internet, where `#server` is deployed.
- `Private server/PC` - It is usually a server or personal computer behind a NAT that has no global ip address and where `#client` is deployed.
- `#server` - `websocket-reverse-proxy` instance with 2 processes: `Process #1` and `Process #2`.
- `#client` -  `websocket-reverse-proxy` instance with 1 process: `Process #3`.
- `Process #1` - an HTTP/HTTPS server to which clients from the Internet connect.
- `Process #2` - websocket server waiting to be connected from `#client` - `Process #3`.
- `Process #3` - websocket client that connects to `#server` - `Process #2`.
- `Process #4` - your backend/web server/any process with network service.

# Essence
1. The (`#server`) has a reverse proxy server that expects(`Process #2`) a connection from a `private server/PC` (`#client` -`Process #3`) as well as requests from users via http/http(`Process #1`). 
2. A `Private server/PC` (`#client`) is deployed on a machine that is not accessible from the global Internet and that establishes a persistent connection (`Process #3`) to the remote server (`#server` - `Process #2`) from which it expects data to be transmitted to the local server (`Process #4`).
3. After receiving the data from the local server (`Process #4`), the private server/PC (`#client` - `Process #3`) transmits the data to the public server (`#server` - `Process #2`) which transmits this data to the users, via the HTTP/HTTPS server (`Process #1`), in response to the pending request.
![Essence](https://github.com/8ai/websocket-reverse-proxy/raw/master/websocket-reverse-proxy.svg "Essence")

# Attention.
Transmission speed is at least 10 times slower than addressing directly to the local server (process #4).

If there is an `ECDH` key, the speed drops 14 times compared to direct access.


## Minimal node version
v11.7.0

## Install
```js
npm install --save websocket-reverse-proxy
```
or
```js
yarn add websocket-reverse-proxy
```


------------



## Config to start `#server`
```js
let config = {
	"type": "server",
	"protocol": "http",
	"serverOptions": {},
	"port": "8080",
	"noConnectionErrorMessage": "No connection yet",
	"compress": "brotli",
	"colors": true,
	"processRequestTimeout": 60000
};
require('websocket-reverse-proxy')(config);
```
Or a simple initialization
```js
require('websocket-reverse-proxy').server(8080, 'someApiKeyIfNeeded'); //init server on port 8080 with apiKey to prevent connections from non autharized clients
```

## Config to start `#client`
```js
let config = {
	"type": "client",
	"remoteServer": "http://example.com:8080",
	"localServer": "http://locahost:80",
	"colors": true
}
require('websocket-reverse-proxy')(config);
```
Or a simple initialization
```js
require('websocket-reverse-proxy').client('http://locahost:80', 'http://example.com:8080', 'someApiKeyIfNeeded'); // initializing the client that connects to the remoteServer and redirects requests from it to the localServer
```

## Include with ES6 
```js
import websocketReverseProxy from 'websocket-reverse-proxy';
websocketReverseProxy(config);
// or
import {server as wsrpServer} from 'websocket-reverse-proxy';
wsrpServer(port, apiKey);
// or
import {server as wsrpClinet} from 'websocket-reverse-proxy';
wsrpClinet(local, remove, apiKey);
```

------------

## Running from command line
All parameters are passed through the space and according to the template `${parameter}=${value}`. Exception: parameters with type Object.
```bash
#! via yarn
yarn run websocket-reverse-proxy run=wrp type=server port=8000 colors=true 

#! via bash run file
./node_modules/.bin/websocket-reverse-proxy run=wrp type=server port=8000 colors=true 
```

------------



## All parameters for `config.type='server'`
### type
**Type**: String

**Default value**: server

**Variants**: server/~~client~~

Server type. If **server**, then HTTP server and websocket server on the specified port are started. If the **client**, then the connection to the `remoteServer` is started and waits for data from it, which is then transmitted to the `localServer`, the response from which is returned to the `remoteServer`.

### port
**Type**: Number

**Default value**: 1080

The port for starting the server, on which it can be accessed.

### apikey
**Type**: String

Authorization key. 

If it is empty or not specified, any websocket client can connect.

### ECDH
**Type**: Boolean

**Default value**: false

Enables data encryption with [ECDH](https://en.wikipedia.org/wiki/Elliptic-curve_Diffie%E2%80%93Hellman)

### protocol
**Type**: String

**Default value**: http

**Variants**: http/https

Protocol or interface to start the server.

### serverOptions
**Type**: Object

**Default value**: {}

All avaliable options for [http](https://nodejs.org/api/http.html#http_http_createserver_options_requestlistener) `protocol` or [https](https://nodejs.org/api/https.html#https_https_createserver_options_requestlistener) `protocol`

### compress
**Type**: String

**Default value**: none

**Variants**: brotli/gzip/deflate/none

Type of data compression during transmission.  When turned on, the load on the processor increases and the transfer rate drops.

### processRequestTimeout
**Type**: Number

**Default value**: 120000

**Variants**: 0-...

Timeout until request is cancelled. If the number is less than 1, then the request will not have a timeout.

### colors
**Type**: Boolean

**Default value**: false

**Variants**: true/false

Enable custom colors for console.log, console.debug, console.error, console.warn, console.info.

### noConnectionErrorMessage
**Type**: String

**Default value**: No connection yet.

A message that is displayed if no connection has been established or lost between the client and the server yet.


------------



## All parameters for `config.type='client'`
### type
**Type**: String

**Default value**: server

**Variants**: client/~~server~~

Client type. If "server", then HTTP server and websocket server on the specified port are started. If the "client", then the connection to the `remoteServer` is started and waits for data from it, which is then transmitted to the `localServer`, the response from which is returned to the `remoteServer`. |

### apikey
**Type**: String

Authorization key. 

If it is empty or not specified, any websocket client can connect.

Ignored for `type=client`, if not specified in `type=server`.

### ECDH
**Type**: Boolean

**Default value**: false

Enables data encryption with [ECDH](https://en.wikipedia.org/wiki/Elliptic-curve_Diffie%E2%80%93Hellman)

### remoteServer
**Alias**: remote

**Type**: String

The server from which it is necessary to establish a connection via websocket

### localServer
**Alias**: local

**Type**: String

The server to which all requests coming from `remoteServer` are proxied

### colors
**Type**: Boolean

**Default value**: false

**Variants**: true/false

Enable custom colors for console.log, console.debug, console.error, console.warn, console.info.