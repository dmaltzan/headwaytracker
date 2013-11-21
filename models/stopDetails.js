var HashTable = require('hashtable');
var pg = require('pg');
var request = require('request');

var stopDetails = new HashTable();
var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';

module.exports = {

  // Initialize tables with GTFS data
  // initialize: function(cb) {
//     var client = new pg.Client(conString);
// 
//     client.on('error', function(error) { console.error('error running query', error); });
//     client.on('drain', client.end.bind(client));
//     client.on('end', function() {
//       console.log('finished initializing stopDetails');
//       cb();
//     });
//     client.connect();
//     client.query('SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops_20130808_20131227', function(err, result) {
//       result.rows.forEach(function(r) {
//         stopDetails.put(r.stop_id, {stop_name: r.stop_name, stop_lat: r.stop_lat, stop_lon: r.stop_lon});
//       });
//     });
//   },
  
  initialize: function(cb, routeIds) {
    var stopsByRouteUrl = 'http://realtime.mbta.com/developer/api/v1/stopsbyroute';
    var apiKey = 'wmgMhi30P0Os2HJ4Md8Csw';
    routeIds.forEach(function(routeId) {
      request({url:stopsByRouteUrl + '?api_key=' + apiKey + '&route=' + routeId,
        headers:{accept: 'application/json'}},
        function(e, r, b) {
          stopDet = JSON.parse(r.body);
          stopDet.direction.forEach(function(d) {
            d.stop.forEach(function(s) {
              if (!stopDetails.get(s.stop_id)) {
                stopDetails.put(s.stop_id, {stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon}); 
              } else {
                //console.log('already had stop ' + s.stop_name);
              }
            });
          });
        }
      );
    });
    cb();
  },
  
  get: function(stopId) {
    return stopDetails.get(stopId);
  }
  
}