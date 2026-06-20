const fs = require("fs/promises");
const path = require("path");

const feedsPath = path.join(__dirname, "feeds.json");
const newsPath = path.join(__dirname, "news.json");
const newsDataPath = path.join(__dirname, "news-data.js");
const timeout = 10000;

const sourceNames = {
  "https://feber.se/rss/": "Feber",
  "https://feeds.expressen.se/nyheter/": "Expressen Nyheter",
  "https://feeds.feedburner.com/uncrate": "Uncrate",
  "https://computersweden.se/feed/": "Computer Sweden",
  "https://www.dagensps.se/feed": "Dagens PS",
  "https://illvet.se/feed/rss": "Illustrerad Vetenskap",
  "https://www.mitti.se/rss-6.8.0.0.e70d15cb3c": "Mitti",
  "https://varldenshistoria.se/feed/rss": "Världens Historia",
  "https://www.sciencedaily.com/rss/all.xml": "ScienceDaily",
  "https://feeds.expressen.se/alltommat/": "Allt om Mat",
  "https://svenska.yle.fi/rss/senaste-nytt": "Svenska Yle",
  "https://www.hammarbyfotboll.se/feed/herrarrss.xml": "Hammarby Fotboll"
};

function decode(value = "") {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return String(value)
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] || match;
      const hex = entity[1].toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    })
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decode(match[1]) : "";
}

function attribute(xml, pattern) {
  return xml.match(pattern)?.[1] || "";
}

function parseFeed(xml, feedUrl) {
  const channel = xml.match(/<channel[\s\S]*?<\/channel>/i)?.[0] || xml;
  const source = sourceNames[feedUrl] || tag(channel, "title") || new URL(feedUrl).hostname;
  const entries = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) || [];

  return entries.map((entry) => {
    const link =
      attribute(entry, /<link[^>]+href=["']([^"']+)["']/i) ||
      tag(entry, "link") ||
      tag(entry, "guid");
    const guid = tag(entry, "guid") || tag(entry, "id") || link;
    const date = tag(entry, "pubDate") || tag(entry, "updated") || tag(entry, "published");
    const enclosure =
      attribute(entry, /<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i) ||
      attribute(entry, /<enclosure[^>]+type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i);
    const media = attribute(entry, /<(?:media:)?(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);

    return {
      title: tag(entry, "title"),
      description: tag(entry, "description") || tag(entry, "summary") || tag(entry, "content"),
      link,
      guid,
      image: enclosure || media,
      source,
      sourceKey: feedUrl,
      timestamp: Date.parse(date) || 0
    };
  }).filter((item) => item.title && item.link);
}

async function fetchFeed(feedUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(feedUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseFeed(await response.text(), feedUrl);
  } finally {
    clearTimeout(timer);
  }
}

function uniqueNewest(items) {
  const seen = new Set();

  return items
    .sort((a, b) => b.timestamp - a.timestamp)
    .filter((item) => {
      const keys = [item.link, item.guid, item.title]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase().trim());
      if (keys.some((key) => seen.has(key))) return false;
      keys.forEach((key) => seen.add(key));
      return true;
    });
}

async function main() {
  const feeds = JSON.parse(await fs.readFile(feedsPath, "utf8"));
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const successful = results.filter(
    (result) => result.status === "fulfilled" && result.value.length
  );
  const items = uniqueNewest(successful.flatMap((result) => result.value));

  if (!items.length) {
    throw new Error("No RSS source responded. Existing cache was left unchanged.");
  }

  const cache = {
    updatedAt: new Date().toISOString(),
    feedCount: feeds.length,
    sourceCount: successful.length,
    items
  };
  const json = JSON.stringify(cache, null, 2);

  await Promise.all([
    fs.writeFile(newsPath, json + "\n", "utf8"),
    fs.writeFile(newsDataPath, `window.KALLRUMMET_NEWS_CACHE = ${json};\n`, "utf8")
  ]);

  console.log(`Wrote ${items.length} articles from ${successful.length}/${feeds.length} sources.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
