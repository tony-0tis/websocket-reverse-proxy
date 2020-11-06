let colors = {
  log: 32,
  info: 32,
  error: 31,
  debug: 36,
  warn: 33
};
module.exports = (obj, config)=>{
  for(let key in colors){
    obj[key] = (original=>{
      return function(...args) {
        if(key == 'debug' && !config.debug) return;
        
        let date = new Date().toLocaleString();
        original.call(obj, '\x1b[37;' + colors[key] + ';1m', `[${date}]`, ...args, '\x1b[0m');
      }
    })(obj[key]);
  }
}