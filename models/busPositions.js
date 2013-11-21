var HashTable = require('hashtable');
var pg = require('pg');
var _ = require('underscore');

var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';

var busPositions = new HashTable();
var busPositionKeys = []; // need to store keys because HashTable doesn't let you iterate through them

module.exports = {

  add: function(positions) {
    positions.forEach(function(e) {
      var busPos = busPositions.get(e.id);
      if (busPos) {
        // if this timestamp has not already been inserted
        if (!(_.find(busPos, function(b) { return b.timestamp == e.vehicle.timestamp.low}))) {
          busPos.push({trip_id: e.vehicle.trip.trip_id, timestamp: +e.vehicle.timestamp, lat: +e.vehicle.position.latitude,
            lon: +e.vehicle.position.longitude, isNew: true, stop_seq: +e.vehicle.current_stop_sequence});
        }
      } else {
        busPositions.put(e.id, [{trip_id: e.vehicle.trip.trip_id, timestamp: +e.vehicle.timestamp, lat: +e.vehicle.position.latitude,
          lon: +e.vehicle.position.longitude, isNew: true, stop_seq: +e.vehicle.current_stop_sequence}]);
        busPositionKeys.push(e.id);
      }
    });
  },
  
  get: function(entityId) {
    return busPositions.get(entityId);
  },
  
  // Iterate over each new position
  forEachNew: function(task) {
    busPositionKeys.forEach(function(k) {
      var pos = busPositions.get(k);
      if (pos && pos[pos.length - 1].isNew) {
        task(k, pos);
        pos[pos.length - 1].isNew = false;
      }
    });
  }
  
}