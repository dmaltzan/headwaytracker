var HashTable = require('hashtable');
var pg = require('pg');
var _ = require('underscore');
var utils = require('../lib/utils');

var stopDetails = new HashTable();
var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';
var mostRecentDatabaseWrite = -1;

var timesAtStopsByStop = new HashTable();

var getTimeAtStopObj = function(entityId, pos, stop, routeId) {   
  var stopLat = stop.stop_lat, stopLon = stop.stop_lon;

  var timeAtStop = estimateTimeAtStop(pos, stopLat, stopLon);
  if (!timeAtStop) return '';
  var d = new Date(0);
  d.setUTCSeconds(timeAtStop);
  var timeAtStopObj = {route_id: routeId, trip_id: pos[0].trip_id, entity_id: entityId, time_at_stop: timeAtStop};

  return timeAtStopObj;
};

var estimateTimeAtStop = function(pos, stopLat, stopLon) {
  for (var i = pos.length - 1; i >= 1; i--) {
    var prevLat = pos[i - 1].lat, prevLon = pos[i - 1].lon, curLat = pos[i].lat, curLon = pos[i].lon;
    if (utils.isBetween(prevLat, prevLon, stopLat, stopLon, curLat, curLon))
    {
      var distPct = utils.getDistance(prevLat, prevLon, stopLat, stopLon) / (utils.getDistance(prevLat, prevLon, stopLat, stopLon) + utils.getDistance(stopLat, stopLon, curLat, curLon));
      return Math.round(pos[i - 1].timestamp + distPct * (pos[i].timestamp - pos[i - 1].timestamp));
    }
  }
  return '';
};

// Insert into stop times in order by stop time (may be out of order if buses are close together)
var insertIntoStopTimes = function(timeAtStopObj, stopTimeDet) {
  console.log('insertIntoStopTimes, timeAtStopObj = ' + JSON.stringify(timeAtStopObj) + ', stopTimeDet = ' + JSON.stringify(stopTimeDet));
  for (var i = stopTimeDet.length; i >= 1; i--) {
    if (stopTimeDet[i - 1].time_at_stop < timeAtStopObj.time_at_stop) {
      console.log('inserting at i = ' + i);
      stopTimeDet.splice(i, 0, timeAtStopObj);
      console.log('now stopTimeDet = ' + JSON.stringify(stopTimeDet));
      return;
    }
  }
  console.log('not found, unshifting');
  stopTimeDet.unshift(timeAtStopObj);
  console.log('now stopTimeDet = ' + JSON.stringify(stopTimeDet));
};



module.exports = {

  handleNewPos: function(k, pos, currentStopPos, currentStopInfo, stream) {  
    var timeAtStopObj = getTimeAtStopObj(k, pos, currentStopPos, currentStopInfo.RouteId);
    if (!timeAtStopObj) return;
    var currentStop = timesAtStopsByStop.get(currentStopInfo.stopId);
    if (!currentStop) {
      timesAtStopsByStop.put(currentStopInfo.stopId, {most_recent_update: new Date(), stop_time_det: [timeAtStopObj]});
      stream.write(timeAtStopObj.route_id + ',' + timeAtStopObj.trip_id + ',' + timeAtStopObj.entity_id + ',' + currentStopInfo.stopId + ',' + timeAtStopObj.time_at_stop + '\n');
    } else {
      if (!_.find(currentStop.stop_time_det, function(st) { return st.entity_id == timeAtStopObj.entity_id && st.time_at_stop == timeAtStopObj.time_at_stop; })) {
        currentStop.most_recent_update = new Date();
        insertIntoStopTimes(timeAtStopObj, currentStop.stop_time_det);
        stream.write(timeAtStopObj.route_id + ',' + timeAtStopObj.trip_id + ',' + timeAtStopObj.entity_id + ',' + currentStopInfo.stopId + ',' + timeAtStopObj.time_at_stop + '\n');
      }
    }
  },
  
  get: function(stopId) {
    return timesAtStopsByStop.get(stopId);
  }

}