var pullable = require('./')

var repos = pullable(process.argv[2])

repos.on('ready', function() {
  repos.listen(7001)
})
