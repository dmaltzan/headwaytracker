module.exports = {
  
  // Returns true if the latitude is in between OR the longitude
  isBetween: function(lat1, lon1, testLat, testLon, lat2, lon1) {
    return (((lat1 < testLat && testLat < lat2) || (lat1 > testLat && testLat > lat2))
      || ((lon1 < testLon && testLon < lon1) || (lon1 > testLon && testLon > lon1)))
  },
  
  getDistance: function(lat1, lon1, lat2, lon2) {
    return Math.sqrt(Math.pow(lat1 - lat2, 2) + Math.pow(lon1 - lon2, 2));
  }
  
}