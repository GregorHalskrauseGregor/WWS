// URL-Inhalte über Jina Reader (rendert auch JS-Seiten, liefert Markdown).
// Ohne Key nutzbar, dann mit Rate-Limit.
const { webFetch } = require('../../web');

module.exports = {
  name: 'jina',
  verfuegbar: () => true,
  benoetigt: null,
  ausfuehren: async (url) => webFetch(url)
};
