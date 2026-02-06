const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Xendit Config
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const XENDIT_API_URL = 'https://api.xendit.co/v2';

const headers = {
  Authorization: `Basic ${Buffer.from(XENDIT_SECRET_KEY + ':').toString('base64')}`,
  'Content-Type': 'application/json',
};

// Root Route
app.get('/', (req, res) => {
  res.send('Booking System Backend is running');
});

// Create Xendit Invoice
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { booking_id, amount, description, remarks, customer_email } = req.body;

    console.log('Creating Xendit invoice for:', { booking_id, amount });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // Xendit Invoice Payload
    const payload = {
      external_id: `booking_${booking_id}_${Date.now()}`,
      amount: amount,
      description: description || 'Event Booking',
      invoice_duration: 86400, // 24 hours
      currency: 'PHP',
      customer: {
        email: customer_email
      },
      success_redirect_url: `${frontendUrl}/payment-status?status=success`,
      failure_redirect_url: `${frontendUrl}/payment-status?status=failed`,
      items: [
        {
          name: description || 'Event Booking',
          quantity: 1,
          price: amount,
          category: 'Event'
        }
      ],
      fees: [], // Add fees if needed
      metadata: {
         booking_id: booking_id,
         remarks: remarks
      }
    };

    const response = await axios.post(
      `${XENDIT_API_URL}/invoices`,
      payload,
      { headers }
    );

    // Map Xendit response to expected format for frontend
    res.json({
      data: {
        attributes: {
          checkout_url: response.data.invoice_url,
          invoice_id: response.data.id
        }
      }
    });
  } catch (error) {
    console.error('Error creating Xendit invoice:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Verify Payment Status (Manual Check)
app.get('/verify-payment/:invoice_id', async (req, res) => {
  try {
    const { invoice_id } = req.params;
    console.log(`Verifying payment for invoice: ${invoice_id}`);

    const response = await axios.get(`${XENDIT_API_URL}/invoices/${invoice_id}`, { headers });
    const invoice = response.data;

    if (invoice.status === 'PAID') {
       // Extract booking_id
       let booking_id = null;
       if (invoice.external_id && invoice.external_id.startsWith('booking_')) {
          booking_id = invoice.external_id.split('_')[1];
       }

       if (booking_id) {
          // Update Supabase
          const { error } = await supabase
            .from('bookings')
            .update({ payment_status: 'Paid', status: 'Confirmed' })
            .eq('id', booking_id);
          
          if (error) console.error('Supabase update error:', error);
          
          return res.json({ status: 'PAID', booking_id });
       }
    }
    
    res.json({ status: invoice.status });
  } catch (error) {
    console.error('Error verifying payment:', error.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Webhook Handler (Xendit)
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    
    // Check for Xendit callback token/signature if needed for security
    // const xCallbackToken = req.headers['x-callback-token'];

    console.log(`Received webhook: ${event.status} for invoice ${event.external_id}`);

    if (event.status === 'PAID') {
      // Structure depends on Xendit Invoice Callback
      // booking_id is in metadata?
      // Xendit might send metadata inside the payload directly or we parse external_id
      
      // Try to get from metadata first if available (needs to be enabled in Xendit dashboard sometimes)
      // Or parse external_id: "booking_{id}_{timestamp}"
      
      let booking_id = null;
      
      // Check metadata if returned
      // Note: Xendit callbacks might not always include full metadata unless configured.
      // But we can parse external_id
      
      if (event.external_id && event.external_id.startsWith('booking_')) {
          const parts = event.external_id.split('_');
          if (parts.length >= 2) {
              booking_id = parts[1];
          }
      }

      console.log('Extracted Booking ID from webhook:', booking_id);

      if (booking_id) {
        console.log(`Payment successful for booking ${booking_id}. Updating status...`);
        
        // Update Supabase
        const { data: updatedData, error } = await supabase
          .from('bookings')
          .update({ 
            payment_status: 'Paid', 
            status: 'Confirmed' 
          })
          .eq('id', booking_id)
          .select();

        if (error) {
          console.error('Error updating booking in Supabase:', JSON.stringify(error, null, 2));
          return res.status(500).send('Database update failed');
        }

        console.log('Booking updated successfully:', updatedData);
      } else {
        console.warn('No booking_id found. Full Payload:', JSON.stringify(event, null, 2));
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
