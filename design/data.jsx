// data.jsx — sample airline ontime data, schema, queries

const SCHEMA = [
  {
    name: 'airline',
    type: 'database',
    expanded: true,
    children: [
      { name: 'ontime', type: 'table', rows: '198.3M', size: '94.1 GB',
        columns: [
          { name: 'Year', type: 'UInt16' },
          { name: 'Quarter', type: 'UInt8' },
          { name: 'Month', type: 'UInt8' },
          { name: 'DayofMonth', type: 'UInt8' },
          { name: 'DayOfWeek', type: 'UInt8' },
          { name: 'FlightDate', type: 'Date' },
          { name: 'Reporting_Airline', type: 'LowCardinality(String)' },
          { name: 'Tail_Number', type: 'String' },
          { name: 'Flight_Number_Reporting_Airline', type: 'String' },
          { name: 'OriginAirportID', type: 'UInt32' },
          { name: 'Origin', type: 'LowCardinality(String)' },
          { name: 'OriginCityName', type: 'String' },
          { name: 'OriginState', type: 'LowCardinality(String)' },
          { name: 'DestAirportID', type: 'UInt32' },
          { name: 'Dest', type: 'LowCardinality(String)' },
          { name: 'DestCityName', type: 'String' },
          { name: 'DestState', type: 'LowCardinality(String)' },
          { name: 'CRSDepTime', type: 'UInt16' },
          { name: 'DepTime', type: 'Nullable(UInt16)' },
          { name: 'DepDelay', type: 'Nullable(Int16)' },
          { name: 'DepDelayMinutes', type: 'Nullable(UInt16)' },
          { name: 'TaxiOut', type: 'Nullable(UInt16)' },
          { name: 'WheelsOff', type: 'Nullable(UInt16)' },
          { name: 'WheelsOn', type: 'Nullable(UInt16)' },
          { name: 'TaxiIn', type: 'Nullable(UInt16)' },
          { name: 'CRSArrTime', type: 'UInt16' },
          { name: 'ArrTime', type: 'Nullable(UInt16)' },
          { name: 'ArrDelay', type: 'Nullable(Int16)' },
          { name: 'ArrDelayMinutes', type: 'Nullable(UInt16)' },
          { name: 'Cancelled', type: 'UInt8' },
          { name: 'CancellationCode', type: 'LowCardinality(String)' },
          { name: 'Diverted', type: 'UInt8' },
          { name: 'AirTime', type: 'Nullable(UInt16)' },
          { name: 'Flights', type: 'UInt8' },
          { name: 'Distance', type: 'UInt16' },
          { name: 'CarrierDelay', type: 'Nullable(UInt16)' },
          { name: 'WeatherDelay', type: 'Nullable(UInt16)' },
          { name: 'NASDelay', type: 'Nullable(UInt16)' },
          { name: 'SecurityDelay', type: 'Nullable(UInt16)' },
          { name: 'LateAircraftDelay', type: 'Nullable(UInt16)' },
        ]},
      { name: 'airports', type: 'table', rows: '6.4K', size: '892 KB',
        columns: [
          { name: 'AirportID', type: 'UInt32' },
          { name: 'Code', type: 'LowCardinality(String)' },
          { name: 'Name', type: 'String' },
          { name: 'City', type: 'String' },
          { name: 'State', type: 'LowCardinality(String)' },
          { name: 'Country', type: 'LowCardinality(String)' },
          { name: 'Lat', type: 'Float64' },
          { name: 'Lon', type: 'Float64' },
        ]},
      { name: 'carriers', type: 'table', rows: '1.5K', size: '124 KB',
        columns: [
          { name: 'Code', type: 'LowCardinality(String)' },
          { name: 'Description', type: 'String' },
        ]},
    ],
  },
  {
    name: 'system',
    type: 'database',
    expanded: false,
    children: [
      { name: 'tables', type: 'table', rows: '142', size: '—' },
      { name: 'columns', type: 'table', rows: '1.8K', size: '—' },
      { name: 'parts', type: 'table', rows: '4.2K', size: '—' },
      { name: 'query_log', type: 'table', rows: '892K', size: '218 MB' },
      { name: 'metrics', type: 'table', rows: '320', size: '—' },
    ],
  },
  {
    name: 'default',
    type: 'database',
    expanded: false,
    children: [],
  },
];

const SAVED_QUERIES = [
  { id: 'q1', name: 'Worst-delay carriers (2023)', starred: true,
    sql: `SELECT Reporting_Airline, avg(DepDelayMinutes) AS avg_delay\nFROM airline.ontime\nWHERE Year = 2023 AND Cancelled = 0\nGROUP BY Reporting_Airline\nORDER BY avg_delay DESC\nLIMIT 15` },
  { id: 'q2', name: 'Busiest origin airports', starred: true,
    sql: `SELECT Origin, count() AS flights\nFROM airline.ontime\nWHERE Year = 2023\nGROUP BY Origin\nORDER BY flights DESC\nLIMIT 20` },
  { id: 'q3', name: 'Monthly cancellations 2019–2023', starred: false,
    sql: `SELECT toStartOfMonth(FlightDate) AS month, sum(Cancelled) AS cancellations\nFROM airline.ontime\nWHERE Year BETWEEN 2019 AND 2023\nGROUP BY month\nORDER BY month` },
  { id: 'q4', name: 'On-time % by day of week', starred: false,
    sql: `SELECT DayOfWeek, round(avg(DepDelayMinutes < 15) * 100, 2) AS ontime_pct\nFROM airline.ontime\nWHERE Year = 2023 AND Cancelled = 0\nGROUP BY DayOfWeek\nORDER BY DayOfWeek` },
];

const HISTORY = [
  { id: 'h1', sql: 'SELECT count() FROM airline.ontime', when: '2 min ago', rows: 1, ms: 12 },
  { id: 'h2', sql: 'SELECT Reporting_Airline, avg(DepDelayMinutes) ...', when: '14 min ago', rows: 15, ms: 218 },
  { id: 'h3', sql: 'DESCRIBE TABLE airline.ontime', when: '32 min ago', rows: 39, ms: 4 },
  { id: 'h4', sql: 'SELECT Origin, count() FROM airline.ontime ...', when: '1 h ago', rows: 20, ms: 184 },
  { id: 'h5', sql: 'SHOW DATABASES', when: '2 h ago', rows: 3, ms: 2 },
  { id: 'h6', sql: 'SELECT * FROM airline.ontime LIMIT 100', when: 'Yesterday', rows: 100, ms: 38 },
];

// Result for "worst-delay carriers" query
const RESULT_DELAYS = {
  columns: [
    { name: 'Reporting_Airline', type: 'String' },
    { name: 'avg_delay', type: 'Float64' },
  ],
  rows: [
    ['B6', 22.41],   // JetBlue
    ['F9', 19.83],   // Frontier
    ['NK', 18.92],   // Spirit
    ['G4', 17.20],   // Allegiant
    ['UA', 14.55],   // United
    ['AA', 13.87],   // American
    ['WN', 13.04],   // Southwest
    ['MQ', 12.61],   // Envoy
    ['9E', 11.98],   // Endeavor
    ['YX', 11.42],   // Republic
    ['OO', 10.85],   // SkyWest
    ['DL', 10.21],   // Delta
    ['AS', 9.76],    // Alaska
    ['HA', 8.93],    // Hawaiian
    ['QX', 7.41],    // Horizon
  ],
  meta: { rows: 15, ms: 218, scanned: '2.41 GB', scannedRows: '64.1M' },
};

const CARRIER_NAMES = {
  B6: 'JetBlue', F9: 'Frontier', NK: 'Spirit', G4: 'Allegiant',
  UA: 'United', AA: 'American', WN: 'Southwest', MQ: 'Envoy',
  '9E': 'Endeavor', YX: 'Republic', OO: 'SkyWest', DL: 'Delta',
  AS: 'Alaska', HA: 'Hawaiian', QX: 'Horizon',
};

// Temporal result — monthly, two measures (drives Line/Area + multi-series demo)
const RESULT_MONTHLY = {
  columns: [
    { name: 'month', type: 'Date' },
    { name: 'cancellations', type: 'UInt32' },
    { name: 'diversions', type: 'UInt32' },
  ],
  rows: [
    ['2023-01-01', 18420, 3210],
    ['2023-02-01', 15880, 2870],
    ['2023-03-01', 14110, 2640],
    ['2023-04-01', 12950, 2510],
    ['2023-05-01', 13670, 2730],
    ['2023-06-01', 21030, 3980],
    ['2023-07-01', 23510, 4320],
    ['2023-08-01', 19980, 3760],
    ['2023-09-01', 11240, 2190],
    ['2023-10-01', 10870, 2050],
    ['2023-11-01', 13320, 2480],
    ['2023-12-01', 22760, 4110],
  ],
  meta: { rows: 12, ms: 96, scanned: '1.18 GB', scannedRows: '31.2M' },
};

// Ordinal-numeric X (DayOfWeek 1–7) + one measure
const RESULT_DOW = {
  columns: [
    { name: 'DayOfWeek', type: 'UInt8' },
    { name: 'ontime_pct', type: 'Float64' },
  ],
  rows: [
    [1, 79.4], [2, 82.1], [3, 83.6], [4, 80.2], [5, 76.8], [6, 85.3], [7, 81.0],
  ],
  meta: { rows: 7, ms: 142, scanned: '2.05 GB', scannedRows: '58.7M' },
};

// Pick a result by inspecting the SQL — lets the demo show different chart
// shapes (bar vs line) depending on what the query looks like.
function pickResult(sql) {
  const s = (sql || '').toLowerCase();
  if (/month|tostartof|flightdate|group by .*\bdate\b/.test(s)) return RESULT_MONTHLY;
  if (/dayofweek/.test(s)) return RESULT_DOW;
  return RESULT_DELAYS;
}

Object.assign(window, { SCHEMA, SAVED_QUERIES, HISTORY, RESULT_DELAYS, RESULT_MONTHLY, RESULT_DOW, CARRIER_NAMES, pickResult });
