import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const {
  PORT = 8080,
  CHATWOOT_BASE_URL,
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_INBOX_ID,
  CHATWOOT_API_TOKEN,
  CHATWOOT_SOURCE_ID = 'Squarespace'
} = process.env;

if (!CHATWOOT_BASE_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_INBOX_ID || !CHATWOOT_API_TOKEN) {
  console.error('Missing required Chatwoot configuration. Check your environment variables.');
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: '1mb' }));

const chatwootHeaders = {
  'Content-Type': 'application/json',
  'api_access_token': CHATWOOT_API_TOKEN
};

function extractField(fields = [], ...aliases) {
  const lowerAliases = aliases.map((alias) => alias.toLowerCase());
  const field = fields.find(({ name }) => lowerAliases.includes(String(name || '').toLowerCase()));
  if (!field) {
    return undefined;
  }

  if (Array.isArray(field.value)) {
    return field.value.join(', ');
  }

  return field.value ?? undefined;
}

async function createOrFindContact({ name, email, phoneNumber, identifier, metadata }) {
  const payload = {
    name,
    email,
    identifier,
    phone_number: phoneNumber,
    custom_attributes: metadata
  };

  const contactResponse = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
    {
      method: 'POST',
      headers: chatwootHeaders,
      body: JSON.stringify(payload)
    }
  );

  if (contactResponse.ok) {
    return contactResponse.json();
  }

  const errorBody = await safeJson(contactResponse);

  // If the contact already exists, look it up using the identifier (email preferred).
  if (contactResponse.status === 422 && identifier) {
    const query = encodeURIComponent(identifier);
    const searchResponse = await fetch(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${query}`,
      { headers: chatwootHeaders }
    );

    if (searchResponse.ok) {
      const result = await searchResponse.json();
      if (result?.payload?.length) {
        return { payload: result.payload[0] };
      }
    }
  }

  throw new Error(`Unable to create or find contact: ${JSON.stringify(errorBody)}`);
}

async function createConversation(contactId) {
  const response = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
    {
      method: 'POST',
      headers: chatwootHeaders,
      body: JSON.stringify({
        contact_id: contactId,
        inbox_id: Number(CHATWOOT_INBOX_ID),
        source_id: CHATWOOT_SOURCE_ID,
        status: 'open'
      })
    }
  );

  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(`Unable to create conversation: ${JSON.stringify(body)}`);
  }

  return response.json();
}

async function createMessage(conversationId, content) {
  const response = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: chatwootHeaders,
      body: JSON.stringify({
        content,
        message_type: 'incoming'
      })
    }
  );

  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(`Unable to append message: ${JSON.stringify(body)}`);
  }

  return response.json();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return { error: response.statusText };
  }
}

app.post('/webhooks/squarespace', async (req, res) => {
  const { formSubmission } = req.body || {};

  if (!formSubmission) {
    console.warn('Received payload without formSubmission:', req.body);
    return res.status(400).json({ error: 'Invalid Squarespace payload' });
  }

  const fields = formSubmission.fields || [];
  const email = extractField(fields, 'email', 'Email Address');
  const phoneNumber = extractField(fields, 'phone', 'Phone Number');
  const name = extractField(fields, 'name', 'Full Name', 'First Name');
  const message = extractField(fields, 'message', 'Question', 'Comments');

  const identifier = email || phoneNumber || formSubmission.id;
  const metadata = {
    squarespace_form_id: formSubmission.id,
    squarespace_form_name: formSubmission.formName,
    squarespace_submission_timestamp: formSubmission.timestamp,
    squarespace_site_id: req.body?.website?.id
  };

  try {
    const contactResult = await createOrFindContact({
      name,
      email,
      phoneNumber,
      identifier,
      metadata
    });

    const contactId = contactResult?.payload?.id || contactResult?.id;

    if (!contactId) {
      throw new Error('Chatwoot contact response did not include an id');
    }

    const conversationResult = await createConversation(contactId);
    const conversationId = conversationResult?.id || conversationResult?.payload?.id;

    if (!conversationId) {
      throw new Error('Chatwoot conversation response did not include an id');
    }

    const content = buildMessageContent({ formSubmission, message, email, phoneNumber, name });

    await createMessage(conversationId, content);

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Failed to relay Squarespace submission to Chatwoot:', error);
    res.status(500).json({ error: 'Failed to relay to Chatwoot' });
  }
});

function buildMessageContent({ formSubmission, message, email, phoneNumber, name }) {
  const lines = [];

  if (message) {
    lines.push(message);
  }

  lines.push('', '--- Submission details ---');

  if (name) {
    lines.push(`Name: ${name}`);
  }
  if (email) {
    lines.push(`Email: ${email}`);
  }
  if (phoneNumber) {
    lines.push(`Phone: ${phoneNumber}`);
  }

  (formSubmission.fields || [])
    .filter(({ name: fieldName }) => !['email', 'email address', 'phone', 'phone number', 'name', 'full name', 'first name', 'message', 'question', 'comments']
      .includes(String(fieldName || '').toLowerCase()))
    .forEach(({ name: fieldName, value }) => {
      lines.push(`${fieldName}: ${Array.isArray(value) ? value.join(', ') : value}`);
    });

  return lines.join('\n');
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Squarespace webhook listener started on port ${PORT}`);
});
