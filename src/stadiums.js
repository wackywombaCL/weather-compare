// NFL stadiums: location, roof and playing surface. Matched to ESPN's venue name.
// roof: "open" (weather matters), "dome" (fixed roof), "retractable" (usually closed in bad
// weather), "canopy" (fixed translucent roof over the field, e.g. SoFi: effectively indoors).
// surface: "grass" (natural or hybrid; gets soft and muddy after heavy rain) or "turf".
// axis: compass bearing (0–180°) of the line between the end zones, measured from the field
// outline in OpenStreetMap; missing where it couldn't be measured (wind then isn't related to the field).
export const STADIUMS = [
  { match: /lambeau/i,               name: "Lambeau Field", team: "Green Bay Packers",            lat: 44.5013, lon: -88.0622,  roof: "open",        surface: "grass" },
  { match: /highmark/i,              name: "Highmark Stadium", team: "Buffalo Bills (Orchard Park, NY)",         lat: 42.7735, lon: -78.7869,  roof: "open",        surface: null },
  { match: /paycor/i,                name: "Paycor Stadium", team: "Cincinnati Bengals",           lat: 39.0955, lon: -84.5160,  roof: "open",        surface: "turf" , axis: 141 },
  { match: /metlife/i,               name: "MetLife Stadium", team: "NY Giants & Jets (East Rutherford, NJ)",          lat: 40.8135, lon: -74.0745,  roof: "open",        surface: "turf" },
  { match: /acrisure/i,              name: "Acrisure Stadium", team: "Pittsburgh Steelers",         lat: 40.4468, lon: -80.0158,  roof: "open",        surface: "grass" },
  { match: /raymond james/i,         name: "Raymond James Stadium", team: "Tampa Bay Buccaneers",    lat: 27.9759, lon: -82.5033,  roof: "open",        surface: "grass" , axis: 0 },
  { match: /everbank|tiaa|jacksonville/i, name: "EverBank Stadium", team: "Jacksonville Jaguars",    lat: 30.3239, lon: -81.6373,  roof: "open",        surface: "grass" },
  { match: /empower|mile high/i,     name: "Empower Field at Mile High", team: "Denver Broncos", lat: 39.7439, lon: -105.0201, roof: "open",      surface: "grass" , axis: 0 },
  { match: /hard rock/i,             name: "Hard Rock Stadium", team: "Miami Dolphins",        lat: 25.9580, lon: -80.2389,  roof: "open",        surface: "grass" , axis: 121 },
  { match: /northwest stadium|fedex field|commanders field/i, name: "Northwest Stadium", team: "Washington Commanders (Landover, MD)", lat: 38.9078, lon: -76.8645, roof: "open", surface: "grass" },
  { match: /lumen/i,                 name: "Lumen Field", team: "Seattle Seahawks",              lat: 47.5952, lon: -122.3316, roof: "open",        surface: "turf" , axis: 0 },
  { match: /gillette/i,              name: "Gillette Stadium", team: "New England Patriots (Foxborough, MA)",         lat: 42.0909, lon: -71.2643,  roof: "open",        surface: "turf" },
  { match: /m&t bank|m & t bank/i,   name: "M&T Bank Stadium", team: "Baltimore Ravens",         lat: 39.2780, lon: -76.6227,  roof: "open",        surface: "grass" , axis: 110 },
  { match: /huntington bank|cleveland browns stadium/i, name: "Huntington Bank Field", team: "Cleveland Browns", lat: 41.5061, lon: -81.6995, roof: "open", surface: "grass" },
  { match: /arrowhead|geha/i,        name: "Arrowhead Stadium", team: "Kansas City Chiefs",        lat: 39.0489, lon: -94.4839,  roof: "open",        surface: "grass" },
  { match: /nissan/i,                name: "Nissan Stadium", team: "Tennessee Titans (Nashville)",           lat: 36.1665, lon: -86.7713,  roof: "open",        surface: "turf" },
  { match: /lincoln financial/i,     name: "Lincoln Financial Field", team: "Philadelphia Eagles",  lat: 39.9008, lon: -75.1675,  roof: "open",        surface: "grass" , axis: 171 },
  { match: /soldier field/i,         name: "Soldier Field", team: "Chicago Bears",            lat: 41.8623, lon: -87.6167,  roof: "open",        surface: "grass" , axis: 176 },
  { match: /bank of america stadium/i, name: "Bank of America Stadium", team: "Carolina Panthers (Charlotte)", lat: 35.2258, lon: -80.8528, roof: "open",        surface: "turf" },
  { match: /levi'?s/i,               name: "Levi's Stadium", team: "San Francisco 49ers (Santa Clara)",           lat: 37.4030, lon: -121.9700, roof: "open",        surface: "grass" },
  { match: /sofi/i,                  name: "SoFi Stadium",             lat: 33.9535, lon: -118.3392, roof: "canopy",      surface: "turf" },
  { match: /allegiant/i,             name: "Allegiant Stadium",        lat: 36.0909, lon: -115.1833, roof: "dome",        surface: "grass" },
  { match: /ford field/i,            name: "Ford Field",               lat: 42.3400, lon: -83.0456,  roof: "dome",        surface: "turf" },
  { match: /u\.?s\.? bank stadium/i, name: "U.S. Bank Stadium",        lat: 44.9737, lon: -93.2581,  roof: "dome",        surface: "turf" },
  { match: /superdome/i,             name: "Caesars Superdome",        lat: 29.9511, lon: -90.0812,  roof: "dome",        surface: "turf" },
  { match: /at&t stadium|at & t stadium/i, name: "AT&T Stadium",       lat: 32.7473, lon: -97.0945,  roof: "retractable", surface: "turf" },
  { match: /nrg/i,                   name: "NRG Stadium",              lat: 29.6847, lon: -95.4107,  roof: "retractable", surface: "turf" },
  { match: /lucas oil/i,             name: "Lucas Oil Stadium",        lat: 39.7601, lon: -86.1639,  roof: "retractable", surface: "turf" },
  { match: /mercedes-benz/i,         name: "Mercedes-Benz Stadium",    lat: 33.7554, lon: -84.4008,  roof: "retractable", surface: "turf" },
  { match: /state farm stadium/i,    name: "State Farm Stadium",       lat: 33.5276, lon: -112.2626, roof: "retractable", surface: "grass" },
  // International games
  { match: /tottenham/i,             name: "Tottenham Hotspur Stadium", lat: 51.6043, lon: -0.0664,  roof: "open",        surface: "turf" , axis: 176 },
  { match: /wembley/i,               name: "Wembley Stadium",          lat: 51.5560, lon: -0.2796,   roof: "open",        surface: "grass" },
  { match: /bernab/i,                name: "Santiago Bernabéu",        lat: 40.4531, lon: -3.6883,   roof: "retractable", surface: "grass" },
  { match: /allianz arena/i,         name: "Allianz Arena",            lat: 48.2188, lon: 11.6247,   roof: "open",        surface: "grass" , axis: 165 },
  { match: /deutsche bank park|frankfurt/i, name: "Deutsche Bank Park", lat: 50.0686, lon: 8.6455,   roof: "open",        surface: "grass" , axis: 127 },
  { match: /olympiastadion|olympic stadium berlin/i, name: "Olympiastadion", lat: 52.5147, lon: 13.2395, roof: "open",  surface: "grass" , axis: 82 },
  { match: /croke park/i,            name: "Croke Park",               lat: 53.3607, lon: -6.2512,   roof: "open",        surface: "grass" , axis: 19 },
  { match: /neo qu[ií]mica|corinthians/i, name: "Neo Química Arena",   lat: -23.5453, lon: -46.4742, roof: "open",        surface: "grass" },
  { match: /azteca|banorte/i,        name: "Estadio Banorte",          lat: 19.3029, lon: -99.1505,  roof: "open",        surface: "grass" , axis: 6 },
  { match: /melbourne cricket|\bmcg\b/i, name: "Melbourne Cricket Ground", lat: -37.8200, lon: 144.9834, roof: "open",  surface: "grass" },
];
export const findStadium = name => STADIUMS.find(s => s.match.test(name || "")) || null;
// Short id used in the daily stadium-tracking files ("Lincoln Financial Field" → "lincoln-financial-field").
export const stadiumKey = s => (s?.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Stadiums tracked every day: open-air and in the US (official hourly observations come from the NWS).
export const TRACKED = STADIUMS.filter(s => s.roof === "open" && s.lat > 24 && s.lat < 50 && s.lon < -60);
