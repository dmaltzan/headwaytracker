var HashTable = require('hashtable');
var pg = require('pg');
var _ = require('underscore');

var tripPatterns = new HashTable();
var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';

module.exports = {

  // Initialize tables with GTFS data
  initialize: function(cb) {
    var client = new pg.Client(conString);

    client.on('error', function(error) { console.error('error running query', error); });
    client.on('drain', client.end.bind(client));
    client.on('end', function() {
      console.log('finished initializing tripPatterns');
      cb();
    });
    client.connect();
    client.query('SELECT t.trip_id, t.route_id, st.stop_sequence, st.stop_id \
                  FROM trips t INNER JOIN routes r ON t.route_id = r.route_id \
                  INNER JOIN gtfs_stop_times_20130808_20131227 st ON st.trip_id = t.trip_id \
                  WHERE r.route_type = $1', ['3'], function(err, result) {
      result.rows.forEach(function(r) {
        if (tripPatterns.get(r.trip_id))
        {
          tripPatterns.get(r.trip_id).stop_pattern.push({stop_sequence: r.stop_sequence, stop_id: r.stop_id});
        }
        else
        {
          tripPatterns.put(r.trip_id, {route_id: r.route_id, stop_pattern: [{stop_sequence: r.stop_sequence, stop_id: r.stop_id}]});
        }
      });
    });
  },
  
  get: function(tripId) {
    return tripPatterns.get(tripId);
  },
  
  getStop: function(tripId, stopSequence) {
    var stop = {};
    var currentTripPattern = tripPatterns.get(tripId);
    if (!currentTripPattern) {
      console.log('no trip found for trip_id ' + tripId);
      return;
    }
    stop.routeId = currentTripPattern.route_id;
    stop.stopId = _.find(currentTripPattern.stop_pattern, function(s) { return s.stop_sequence == stopSequence; }).stop_id;
    
    stop.isTerminal = false;
    if (stopSequence == '1' || stopSequence == _.max(currentTripPattern.stop_pattern, function(t) { return +t.stop_sequence; }).stop_sequence) {
      stop.isTerminal = true;
    }
    
    return stop;
  }
  
}