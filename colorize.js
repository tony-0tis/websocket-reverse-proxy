let colors = {
  log: 32,
  info: 32,
  error: 31,
  debug: 36,
  warn: 33
};
module.exports = (obj, config)=>{
  if(obj._colorized) return;
  for(let key in colors){
    obj[key] = (original=>{
      return function(...args) {
        if(key == 'debug' && !config.debug) return;
        else if(key == 'debug'){
          console.warn('config.debug', !config.debug)
        }
        
        let date = new Date().toLocaleString();
        if(config.colors){
          original.call(obj, '\x1b[37;' + colors[key] + ';1m', `[${date}]`, ...args, '\x1b[0m');
        }
        else{
          original.call(obj, `[${date}]`, ...args);
        }
      }
    })(obj[key]);
  }
  obj._colorized = true;
}