// Web-Suche über die Brave Search API (EU, eigener Index).
const { webSearch } = require('../../web');

module.exports = {
  name: 'brave',
  verfuegbar: () => !!process.env.BRAVE_API_KEY,
  benoetigt: 'BRAVE_API_KEY',
  ausfuehren: async (query, maxResults) => webSearch(query, { maxResults })
};
