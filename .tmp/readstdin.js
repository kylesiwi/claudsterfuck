const fs = require('fs');
const data = fs.readFileSync(0, 'utf8');
console.log('NODE_STDIN_BYTES=' + data.length);
console.log('NODE_STDIN=' + JSON.stringify(data));
