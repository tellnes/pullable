# Pullable

Pullable serves git repositories in read only mode over http.


## Example
```js
var pullable = require('pullable')

var repo = pullable('/path/to/git/repository/.git')

repo.on('ready', function() {
  repo.listen(7001)
})
```


## Install

    npm install pullable


## Licence

MIT
