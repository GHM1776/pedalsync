// ============================================================
// PedalSync — Workout Recording & TCX Export
// Records data points every 5s, exports to TCX for Strava/Garmin
// ============================================================
(function() {
  var s = PS.state;
  var RECORD_INTERVAL = 5; // seconds between data points
  var lastExportAt = 0;    // debounce — a double-tap produced two identical files in the field

  // ---- Record a data point (called from main update loop) ----
  window.recordDataPoint = function() {
    if (!s.rideActive) return;
    var now = Date.now() / 1000;
    if (now - s.lastRecordTime < RECORD_INTERVAL) return;
    s.lastRecordTime = now;

    var point = {
      time: new Date().toISOString(),
      elapsed: s.rideElapsed,
      equipmentType: s.equipmentType,
    };

    // Heart rate is equipment-independent. Through PS.hr.current() and never
    // s.heartRate with an inline guard: an inline check catches contact loss but
    // misses the notification timeout, so a strap whose battery dies mid-ride
    // would keep writing its last value into every remaining trackpoint — the
    // tile showing a dash while the file recorded a flatline.
    var hr = (PS.hr && PS.hr.current) ? PS.hr.current() : 0;
    if (hr > 0) point.heartRate = hr;

    if (s.equipmentType === 'rower') {
      point.cadence = s.rowerSPM;
      point.power = s.rowerPower;
      point.resistance = s.resistance;
      point.distance = s.rowerDistance;
      point.calories = s.rowerCalories;
      point.strokes = s.rowerStrokes;
      point.splitSec = s.rowerSplitSec;
    } else if (s.equipmentType === 'treadmill') {
      point.speed = s.treadSpeed;
      point.incline = s.treadIncline;
      point.distance = s.totalDistance * 1609.34; // miles to meters
      point.calories = s.totalCalories;
      point.steps = s.treadSteps;
    } else {
      point.cadence = s.cadence;
      point.power = Math.round(s.power);
      point.resistance = s.resistance;
      point.distance = s.totalDistance * 1000; // km to meters
      point.calories = s.totalCalories;
    }

    s.recordedPoints.push(point);
  };

  // ---- Generate TCX XML ----
  function generateTCX() {
    var points = s.recordedPoints;
    if (points.length === 0) return null;

    var startTime = s.rideStartDate ? s.rideStartDate.toISOString() : points[0].time;
    var lastPoint = points[points.length - 1];
    var totalTime = s.rideElapsed;
    var type = s.equipmentType;

    // TCX sport type
    var sport = 'Other';
    if (type === 'bike') sport = 'Biking';
    if (type === 'treadmill') sport = 'Running';

    // Total distance in meters
    var totalDist = 0;
    if (type === 'rower') {
      totalDist = s.rowerDistance;
    } else if (type === 'treadmill') {
      totalDist = s.totalDistance * 1609.34;
    } else {
      totalDist = s.totalDistance * 1000;
    }

    // Total calories
    var totalCal = 0;
    if (type === 'rower') {
      totalCal = s.rowerCalories;
    } else {
      totalCal = Math.round(s.totalCalories);
    }

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    // xmlns:xsi must be declared at the root: the only other declaration is on
    // <Creator>, scoped to that element, so an xsi:type on a trackpoint earlier
    // in the document would be an undeclared prefix and the file unparseable.
    // Unconditional — every real Garmin TCX carries it and it is valid with or
    // without heart rate.
    xml += '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" ';
    xml += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ';
    xml += 'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n';
    xml += '  <Activities>\n';
    xml += '    <Activity Sport="' + sport + '">\n';
    xml += '      <Id>' + startTime + '</Id>\n';
    xml += '      <Lap StartTime="' + startTime + '">\n';
    xml += '        <TotalTimeSeconds>' + Math.round(totalTime) + '</TotalTimeSeconds>\n';
    xml += '        <DistanceMeters>' + totalDist.toFixed(1) + '</DistanceMeters>\n';
    xml += '        <Calories>' + totalCal + '</Calories>\n';
    // ActivityLap_t order: ...Calories, AverageHeartRateBpm?, MaximumHeartRateBpm?,
    // Intensity... Strava recomputes these from the trackpoints, but Garmin
    // Connect and TrainingPeaks read them.
    if (s.hrSamples && s.hrSamples.length) {
      var hrSum = 0, hrMax = 0;
      for (var h = 0; h < s.hrSamples.length; h++) {
        hrSum += s.hrSamples[h].bpm;
        if (s.hrSamples[h].bpm > hrMax) hrMax = s.hrSamples[h].bpm;
      }
      xml += '        <AverageHeartRateBpm xsi:type="HeartRateInBeatsPerMinute_t"><Value>' +
             Math.round(hrSum / s.hrSamples.length) + '</Value></AverageHeartRateBpm>\n';
      xml += '        <MaximumHeartRateBpm xsi:type="HeartRateInBeatsPerMinute_t"><Value>' +
             Math.round(hrMax) + '</Value></MaximumHeartRateBpm>\n';
    }
    xml += '        <Intensity>Active</Intensity>\n';
    xml += '        <TriggerMethod>Manual</TriggerMethod>\n';
    xml += '        <Track>\n';

    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      xml += '          <Trackpoint>\n';
      xml += '            <Time>' + p.time + '</Time>\n';

      if (p.distance !== undefined) {
        var dist = (type === 'rower') ? p.distance : p.distance;
        xml += '            <DistanceMeters>' + dist.toFixed(1) + '</DistanceMeters>\n';
      }

      // Trackpoint_t is an ordered sequence — HeartRateBpm belongs between
      // DistanceMeters and Cadence. Out of order, the file fails validation and
      // Garmin Connect rejects it. Whole numbers only: Garmin rejects decimals
      // in heart rate, cadence, watts and calories.
      if (p.heartRate !== undefined) {
        xml += '            <HeartRateBpm xsi:type="HeartRateInBeatsPerMinute_t">\n';
        xml += '              <Value>' + Math.round(p.heartRate) + '</Value>\n';
        xml += '            </HeartRateBpm>\n';
      }

      // Cadence (bikes and rowers use this field)
      if (p.cadence !== undefined && type === 'bike') {
        xml += '            <Cadence>' + p.cadence + '</Cadence>\n';
      }

      // Extensions: power, cadence for rower, speed for treadmill
      var hasExtensions = (p.power !== undefined && p.power > 0) ||
                          (type === 'rower' && p.cadence !== undefined) ||
                          (type === 'treadmill' && p.speed !== undefined);
      if (hasExtensions) {
        xml += '            <Extensions>\n';
        xml += '              <ns3:TPX>\n';
        if (p.power !== undefined && p.power > 0) {
          xml += '                <ns3:Watts>' + Math.round(p.power) + '</ns3:Watts>\n';
        }
        if (type === 'treadmill' && p.speed !== undefined) {
          // TCX speed is in m/s
          xml += '                <ns3:Speed>' + (p.speed * 0.44704).toFixed(2) + '</ns3:Speed>\n';
        }
        if (type === 'rower' && p.cadence !== undefined) {
          // Strava reads RunCadence for rowing SPM
          xml += '                <ns3:RunCadence>' + p.cadence + '</ns3:RunCadence>\n';
        }
        xml += '              </ns3:TPX>\n';
        xml += '            </Extensions>\n';
      }

      xml += '          </Trackpoint>\n';
    }

    xml += '        </Track>\n';
    xml += '      </Lap>\n';
    xml += '      <Creator xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Device_t">\n';
    xml += '        <Name>PedalSync</Name>\n';
    xml += '      </Creator>\n';
    xml += '    </Activity>\n';
    xml += '  </Activities>\n';
    xml += '</TrainingCenterDatabase>';

    return xml;
  }

  // ---- Download TCX file ----
  window.exportWorkout = function() {
    if (s.recordedPoints.length < 2) {
      alert('Nothing to export yet — try again after a minute of your workout.');
      if (window.__pulse) window.__pulse('export', s.equipmentType + ':empty');
      return;
    }

    if (Date.now() - lastExportAt < 3000) {
      if (window.__pulse) window.__pulse('export', s.equipmentType + ':dup');
      return;
    }

    try {
      var tcx = generateTCX();
      if (!tcx) {
        if (window.__pulse) window.__pulse('debug', 'Export failed: TCX generation returned null');
        return;
      }

      var type = s.equipmentType;
      var date = (s.rideStartDate || new Date()).toISOString().substring(0, 10);
      var filename = 'pedalsync-' + type + '-' + date + '.tcx';

      var blob = new Blob([tcx], { type: 'application/vnd.garmin.tcx+xml' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      lastExportAt = Date.now();
      if (window.__pulse) window.__pulse('export', type);
    } catch(err) {
      if (window.__pulse) window.__pulse('debug', 'Export error: ' + (err.message || 'unknown'));
      alert('Export failed. Please try again.');
    }
  };
})();