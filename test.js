/**
 * Test script untuk X Scraper Bot
 * Usage: node test.js [command]
 */

require('dotenv').config();

const command = process.argv[2];

if (!command) {
  console.log(`
🧪 X Scraper Bot - Test Script

Usage: node test.js [command]

Commands:
  test:waha      - Test WAHA connection
  test:scraper   - Test scraping satu akun
  test:send      - Test kirim pesan ke WA
  stats          - Lihat statistik database
  logs           - Lihat 50 log terakhir
`);
  process.exit(0);
}

const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs');

const CONFIG = {
  wahaUrl: process.env.WAHA_URL || 'http://localhost:3000',
  wahaSession: process.env.WAHA_SESSION || 'default',
  wahaChannelId: process.env.WAHA_CHANNEL_ID,
  targetAccounts: (process.env.TARGET_ACCOUNTS || '').split(',').filter(Boolean),
};

// Test WAHA
async function testWaha() {
  console.log('\n🔍 Testing WAHA connection...\n');

  try {
    const response = await axios.get(`${CONFIG.wahaUrl}/api/sessions/${CONFIG.wahaSession}`, {
      timeout: 5000,
    });

    console.log('✅ WAHA Response:');
    console.log('   State:', response.data?.state);
    console.log('   Engine:', response.data?.engine);
    console.log('   Phone:', response.data?.me?.phone);

    if (response.data?.state === 'CONNECTED') {
      console.log('\n✅ WAHA is healthy!');
    } else {
      console.log('\n⚠️ WAHA is not connected. Scan QR code first.');
    }

  } catch (error) {
    console.error('❌ WAHA connection failed:', error.message);
    console.log('\nPastikan:');
    console.log('1. WAHA sudah running (docker-compose up waha)');
    console.log('2. WAHA_URL di .env sudah benar');
  }
}

// Test kirim pesan
async function testSend() {
  console.log('\n📤 Testing send message to WhatsApp...\n');

  if (!CONFIG.wahaChannelId) {
    console.error('❌ WAHA_CHANNEL_ID belum di-set di .env');
    return;
  }

  try {
    const response = await axios.post(
      `${CONFIG.wahaUrl}/api/sendText`,
      {
        session: CONFIG.wahaSession,
        chatId: CONFIG.wahaChannelId,
        text: '🧪 Test message dari X Scraper Bot!\n\nJika kamu melihat ini, setup sudah benar ✅',
        linkPreview: false,
      },
      { timeout: 30000 }
    );

    console.log('✅ Message sent successfully!');
    console.log('   Message ID:', response.data?.id);
    console.log('   Timestamp:', response.data?.timestamp);

  } catch (error) {
    console.error('❌ Failed to send:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
  }
}

// Test scraper
async function testScraper() {
  const puppeteer = require('puppeteer');
  const username = CONFIG.targetAccounts[0] || 'elonmusk';

  console.log(`\n🐦 Testing scraper for @${username}...\n`);

  const browser = await puppeteer.launch({
    headless: false, // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('1. Opening browser...');
    await page.goto(`https://twitter.com/${username}`, { 
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    console.log('2. Waiting for content...');
    await page.waitForTimeout(3000);

    // Close login popup if exists
    try {
      const closeBtn = await page.$('[data-testid="app-bar-close"]');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(1000);
        console.log('3. Closed login popup');
      }
    } catch (e) {}

    // Extract tweets
    console.log('4. Extracting tweets...');
    const tweets = await page.evaluate(() => {
      const results = [];
      const elements = document.querySelectorAll('article[data-testid="tweet"]');

      elements.forEach((el, i) => {
        if (i >= 3) return; // Only get first 3

        const textEl = el.querySelector('[data-testid="tweetText"]');
        const timeEl = el.querySelector('time');
        const linkEl = timeEl?.closest('a');
        
        results.push({
          text: textEl?.textContent?.substring(0, 100) || 'No text',
          time: timeEl?.getAttribute('datetime'),
          href: linkEl?.href,
        });
      });

      return results;
    });

    console.log('\n✅ Scraped tweets:');
    tweets.forEach((tweet, i) => {
      console.log(`\n${i + 1}. ${tweet.text}...`);
      console.log(`   Time: ${tweet.time}`);
      console.log(`   URL: ${tweet.href}`);
    });

    console.log('\n✅ Scraper test passed!');
    console.log('Browser akan ditutu dalam 5 detik...');
    await page.waitForTimeout(5000);

  } catch (error) {
    console.error('❌ Scraper test failed:', error.message);
  } finally {
    await browser.close();
  }
}

// Show stats
function showStats() {
  console.log('\n📊 Database Statistics\n');

  try {
    const db = new Database('./data/bot.db');
    
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(posted_to_whatsapp) as posted
      FROM tweets
    `).get();

    const recent = db.prepare(`
      SELECT username, content, posted_to_whatsapp, created_at
      FROM tweets
      ORDER BY created_at DESC
      LIMIT 5
    `).all();

    console.log('Total tweets tracked:', stats.total);
    console.log('Posted to WhatsApp:', stats.posted);
    console.log('\nRecent tweets:');
    recent.forEach((t, i) => {
      const status = t.posted_to_whatsapp ? '✅' : '⏳';
      console.log(`${i + 1}. [${status}] @${t.username}: ${t.content?.substring(0, 50)}...`);
    });

    db.close();
  } catch (error) {
    console.error('❌ Database error:', error.message);
  }
}

// Show logs
function showLogs() {
  console.log('\n📜 Recent Logs\n');

  try {
    const logs = fs.readFileSync('./logs/bot.log', 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-50);

    logs.forEach((line) => {
      try {
        const log = JSON.parse(line);
        const time = log.timestamp?.split('T')[1]?.split('.')[0] || '';
        console.log(`[${time}] [${log.level?.toUpperCase()}]: ${log.message}`);
      } catch (e) {
        console.log(line);
      }
    });
  } catch (error) {
    console.log('No logs yet or error reading logs');
  }
}

// Run command
(async () => {
  switch (command) {
    case 'test:waha':
      await testWaha();
      break;
    case 'test:send':
      await testSend();
      break;
    case 'test:scraper':
      await testScraper();
      break;
    case 'stats':
      showStats();
      break;
    case 'logs':
      showLogs();
      break;
    default:
      console.log('Unknown command:', command);
  }

  console.log('\n');
  process.exit(0);
})();
