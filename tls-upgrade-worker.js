import { EmailMessage } from "cloudflare:email";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeHeaderValue(str) {
  return String(str).replace(/[\r\n]/g, '');
}

export default {
  // Fetch handler - for manual triggering (requires AUTH_SECRET)
  async fetch(request, env, ctx) {
    // Authenticate request
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.AUTH_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      await this.scheduled(null, env, ctx);
      return new Response('TLS upgrade check completed.', { status: 200 });
    } catch (error) {
      console.error('Fetch handler error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  },

  // Scheduled handler - runs on cron
  async scheduled(event, env, ctx) {
    try {
      console.log('Starting TLS 1.3 upgrade check...');

      const zones = await getAllZones(env.CF_API_TOKEN);
      console.log(`Found ${zones.length} zones to check`);

      let checkedCount = 0;
      let upgradedCount = 0;
      let alreadyUpgradedCount = 0;

      for (const zone of zones) {
        checkedCount++;

        const currentTLS = await getZoneTLSVersion(zone.id, env.CF_API_TOKEN);

        if (currentTLS !== '1.3') {
          console.log(`Zone ${zone.name} (${zone.id}) is on TLS ${currentTLS}, upgrading to 1.3...`);
          await upgradeZoneToTLS13(zone.id, env.CF_API_TOKEN);
          upgradedCount++;
          console.log(`Upgraded ${zone.name} to TLS 1.3`);

          // Send to queue for email notification
          console.log(`Sending message to queue for ${zone.name}...`);
          await env.TLS_UPGRADE_QUEUE.send({
            zoneName: zone.name,
            zoneId: zone.id,
            previousTLS: currentTLS,
            newTLS: '1.3',
            timestamp: new Date().toISOString(),
          });
          console.log(`Message sent to queue successfully`);
        } else {
          alreadyUpgradedCount++;
          console.log(`Zone ${zone.name} (${zone.id}) already on TLS 1.3`);
        }
      }

      console.log('=== TLS Upgrade Summary ===');
      console.log(`Total zones checked: ${checkedCount}`);
      console.log(`Already on TLS 1.3: ${alreadyUpgradedCount}`);
      console.log(`Upgraded to TLS 1.3: ${upgradedCount}`);

    } catch (error) {
      console.error('Error during TLS upgrade process:', error);
      throw error;
    }
  },

  // Queue handler - processes messages and sends emails
  async queue(batch, env) {
    console.log(`Queue handler triggered with ${batch.messages.length} messages`);

    for (const message of batch.messages) {
      try {
        const { zoneName, zoneId, previousTLS, newTLS, timestamp } = message.body;

        console.log(`Processing message for zone: ${zoneName}`);

        // Sanitize values for HTML email body
        const safeZoneName = escapeHtml(zoneName);
        const safeZoneId = escapeHtml(zoneId);
        const safePreviousTLS = escapeHtml(previousTLS);
        const safeNewTLS = escapeHtml(newTLS);
        const safeTimestamp = escapeHtml(new Date(timestamp).toLocaleString());

        const emailHtml = `
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #f4771b; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 0 0 5px 5px; }
    .detail { margin: 10px 0; }
    .label { font-weight: bold; color: #555; }
    .success { color: #28a745; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>TLS Version Upgraded</h2>
    </div>
    <div class="content">
      <p>A Cloudflare zone has been successfully upgraded to TLS 1.3:</p>
      <div class="detail"><span class="label">Zone Name:</span> ${safeZoneName}</div>
      <div class="detail"><span class="label">Zone ID:</span> ${safeZoneId}</div>
      <div class="detail"><span class="label">Previous TLS Version:</span> ${safePreviousTLS}</div>
      <div class="detail"><span class="label">New TLS Version:</span> <span class="success">${safeNewTLS}</span></div>
      <div class="detail"><span class="label">Timestamp:</span> ${safeTimestamp}</div>
      <p style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 0.9em;">
        This is an automated notification from your TLS Upgrade Worker.
      </p>
    </div>
  </div>
</body>
</html>
        `.trim();

        // Sanitize subject to prevent header injection
        const subject = sanitizeHeaderValue(`TLS Upgrade Alert: ${zoneName}`);
        const messageId = `<${Date.now()}.${Math.random().toString(36).substring(7)}@easydemo.org>`;
        const headers = `From: TLS Upgrade Worker <noreply@easydemo.org>\r\n` +
          `To: nicholas.kuntz@cloudflare.com\r\n` +
          `Subject: ${subject}\r\n` +
          `Message-ID: ${messageId}\r\n` +
          `Date: ${new Date().toUTCString()}\r\n` +
          `Content-Type: text/html; charset=utf-8\r\n\r\n`;

        const rawEmail = headers + emailHtml;

        const emailMessage = new EmailMessage(
          "noreply@easydemo.org",
          "nicholas.kuntz@cloudflare.com",
          rawEmail
        );

        await env.EMAIL.send(emailMessage);

        console.log(`Email sent successfully for zone: ${zoneName}`);
        message.ack();
      } catch (error) {
        console.error(`Failed to send email for zone ${message.body?.zoneName}:`, error.message);
        message.retry();
      }
    }

    console.log(`Queue handler completed processing ${batch.messages.length} messages`);
  },
};

async function getAllZones(apiToken) {
  const zones = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones?page=${page}&per_page=50`,
      {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch zones: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(`API error: ${JSON.stringify(data.errors)}`);
    }

    zones.push(...data.result);
    hasMore = data.result_info.page < data.result_info.total_pages;
    page++;
  }

  return zones;
}

async function getZoneTLSVersion(zoneId, apiToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/min_tls_version`,
    {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get TLS version for zone ${zoneId}: ${response.status}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(`API error getting TLS version: ${JSON.stringify(data.errors)}`);
  }

  return data.result.value;
}

async function upgradeZoneToTLS13(zoneId, apiToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/min_tls_version`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: '1.3' }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to upgrade zone ${zoneId}: ${response.status}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(`API error upgrading zone: ${JSON.stringify(data.errors)}`);
  }

  return data.result;
}
