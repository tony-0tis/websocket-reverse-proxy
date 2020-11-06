const zlib = require('zlib');
const http = require('http');
const https = require('https');
const websocket = require('ws');

module.exports = config=>{
  if(config.colors) require('./colorize')(console, config);
  console.warn('Start server');
  let remoteSocket = null;
  let protocol = config.protocol == 'https' ? https : http;
  let options = config.serverOptions || {};
  const server = protocol.createServer(options);
  server.on('request', (request, response)=>{
    if(!remoteSocket) {
      response.writeHead(503, 'No connection yet');
      return response.end(`
        <div style="height: 100%;display: flex;justify-content: center;align-items: center;font-size: 120%;font-family: serif;font-weight: bold;">
          ${config.noConnectionErrorMessage || 'No connection yet.'}
        </div>
      `);
    }

    remoteSocket.processRequest(request, response);
  });
  server.listen(config.port || 1080, ()=>{
    console.log('# Socket and http servers started on port', config.port || 1080);
  });

  const wss = new websocket.Server({server});
  wss.on('connection', ws=>{
    console.log('# Websocket connected');
    if(!config.apikey){
      remoteSocket = iniSocket(ws, config);
    }

    ws.on('ping', data=>{
      ws.pong();
    });

    ws.on('close', (code, reason)=>{
      if(typeof code != 'number') code = 1001;
      if(typeof reason == 'undefined') reason = 'closed';
      console.log('# Websocket closed')
      
      if(ws){
        ws.close(code, reason);
      }
      ws = null;
    });

    ws.on('message', data=>{
      try{
        data = JSON.parse(data);
      }catch(e){}

      if(config.apikey && data.type == 'auth'){
        if(data.apikey == config.apikey){
          if(remoteSocket && remoteSocket.readyState === websocket.OPEN){
            remoteSocket.close(1016, 'new connection');
          }

          remoteSocket = iniSocket(ws, config);
        }
        else{
          ws.send(JSON.stringify({error: 'wrong auth'}));
        }
      }
    });

    process.on('exit', (code)=>{
      console.log('close socket by process exit', code);
      ws.close(1001);
    });
  });
};

function iniSocket(socket, config) {
  console.log('# RemoteSocket setted');
  socket.on('message', data=>{
    try{
      data = JSON.parse(data);
    }catch(e){}

    if(data.type == 'requestStartRecieved'){
      if(!socket._callbacks[data.id] || !socket._callbacks[data.id].parts['start']){
        return console.error(data.id, '% 1.1) requestStartRecieved - No callback for start');
      }

      console.debug(data.id, '< 1.1) requestStartRecieved');
      socket._callbacks[data.id].parts['start'].next();
      return;
    }

    if(data.type == 'requestPartRecieved'){
      if(!data.partId || !socket._callbacks[data.id] || !socket._callbacks[data.id].parts[data.partId]){
        return console.error(data.id, '% 3.1) requestPartRecieved - No callback for part');
      }

      console.debug(data.id, '< 3.1) requestPartRecieved');
      socket._callbacks[data.id].parts[data.partId].next();
      return;
    }

    if(data.type == 'requestEndRecieved'){
      if(!socket._callbacks[data.id] || !socket._callbacks[data.id].parts['end']) {
        return console.info(data.id, '% 5.1) requestEndRecieved - no such response id');
      }
      
      socket._callbacks[data.id].sended = true;

      socket._callbacks[data.id].parts['end'].next();
      console.debug(data.id, '< 5.1) requestEndRecieved');
      return;
    }

    if(data.type == 'responseStart'){
      socket.responseStart(data);
      return;
    }

    if(data.type == 'responsePart'){
      socket.responsePart(data);
      return;
    }

    if(data.type == 'responseEnd'){
      socket.responseEnd(data);
      return;
    }

    console.warn('resend messate', data);
    socket.send(JSON.stringify(data));
  });
  socket._callbacks = {};
  socket.sendWithCheck = function(partId, data, next){
    return new Promise((ok,bad)=>{
      this._callbacks[data.id].parts[partId] = {
        next(){
          clearInterval(this.si);
          delete socket._callbacks[data.id].parts[partId];
          next && next();
          ok();
        },
        si: setInterval(()=>this.send(JSON.stringify(data)), 1000)
      };

      this.send(JSON.stringify(data));
    });
  };
  socket.processRequest = async function(request, response) {
    let id = (Math.random()).toString(36);

    console.log(id, '> New url to obtain', request.url);

    response.on('close', ()=>{
      this.cancelResponse(id);
    });
    
    this._callbacks[id] = {
      id: id,
      canceled: false,
      parts: {},
      startCb: start=>response.writeHead(start.code, start.headers),
      partCb: part=>response.write(part.body),
      endCb: end=>response.end(),
    };
    if(config.processRequestTimeout != 0){
       this._callbacks[id].si = setInterval(()=>{
        this.cancelResponse(id);
      }, config.processRequestTimeout || 120000);
    }

    request.pause();

    console.debug(id, '> 1) Init request', request.url);
    await this.sendWithCheck('start', {
      type: 'requestStart',
      id: id,
      url: request.url,
      method: request.method,
      headers: request.headers,
      compress: config.compress
    });

    request.resume();

    request.on('data', async chunk=>{
      if(!this._callbacks[id]) {
        return;
      }

      request.pause();

      if(config.compress == 'deflate') chunk = zlib.deflateSync(chunk);
      else if(config.compress == 'gzip') chunk = zlib.gzipSync(chunk);
      else if(config.compress == 'brotli') chunk = zlib.brotliCompressSync(chunk); 

      console.debug(id, '> 3) Request part', partId);
      let partId = (Math.random()).toString(36);
      await this.sendWithCheck(partId, {
        type: 'requestPart',
        id: id,
        body: chunk,
        partId: partId
      });

      request.resume();
    });
    request.on('end', ()=>{
      if(!this._callbacks[id]) {
        return;
      }

      console.debug(id, '> 5) Request end');
      this.sendWithCheck('end', {
        type: 'requestEnd',
        id: id
      });
    });
  };
  socket.responseStart = function(data) {
    if(!data || !data.id || !this._callbacks[data.id]){
      console.info(data.id, '8) % ResponseStart - no such response id');
      return;
    }

    console.debug(data.id, '< 8) Start to return(headers)');

    this.send(JSON.stringify({type: 'responseStartRecieved', id: data.id}));
    this._callbacks[data.id].startCb(data);
  };
  socket.responsePart = function(data){
    this.send(JSON.stringify({type: 'responsePartRecieved', id: data.id, partId: data.partId}));

    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% 10) ResponsePart - no such response id');
      return;
    }

    if(data.body && data.body.type == 'Buffer'){
      data.body = Buffer.from(data.body.data);
    }
    if(typeof data.body == 'object' && !Object.keys(data.body).length){
      data.body = '';
    }

    if(config.compress == 'deflate') data.body = zlib.inflateSync(data.body);
    else if(config.compress == 'gzip') data.body = zlib.gunzipSync(data.body);
    else if(config.compress == 'brotli') data.body = zlib.brotliDecompressSync(data.body);

    console.debug(data.id, '< 10) Part to return:', data.partId);
    
    this._callbacks[data.id].partCb(data);
  };
  socket.responseEnd = function(data){
    this.send(JSON.stringify({type: 'responseEndRecieved', id: data.id}));

    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% 12) ResponseEnd - no such response id');
      return;
    }

    if(data.body){
      if(data.body && data.body.type == 'Buffer'){
        data.body = Buffer.from(data.body.data);
      }
      if(typeof data.body == 'object' && !Object.keys(data.body).length){
        data.body = '';
      }

      if(config.compress == 'deflate') data.body = zlib.inflateSync(data.body);
      else if(config.compress == 'gzip') data.body = zlib.gunzipSync(data.body);
      else if(config.compress == 'brotli') data.body = zlib.brotliDecompressSync(data.body);
      this._callbacks[data.id].partCb(data);
    }

    console.debug(data.id, '< 12) End to return');
    this._callbacks[data.id].endCb(data);
    this.cancelResponse(data.id);
  };
  socket.cancelResponse = function(id){
    if(!this._callbacks[id]){
      //console.debug('% CancelResponse - no such response id', id);
      return;
    }

    console.debug(id, '< Cancel response');

    this.send(JSON.stringify({type: 'cancelResponse', id: id}));
    
    clearInterval(this._callbacks[id].si);
    if(this._callbacks[id].parts){
      for(let key in this._callbacks[id].parts){
        clearInterval(this._callbacks[id].parts[key].si);
      }
    }
    delete this._callbacks[id];
  };
  return socket;
}