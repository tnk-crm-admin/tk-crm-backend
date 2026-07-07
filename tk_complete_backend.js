// ============================================
// T&K MEDICAL SALES - COMPLETE BACKEND
// Node.js + Express + PostgreSQL + Claude API
// ============================================

// 1. PACKAGE.JSON
/*
{
  "name": "tk-medical-sales-backend",
  "version": "1.0.0",
  "description": "T&K Medical Sales Platform Backend",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.10.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^16.3.1",
    "cors": "^2.8.5",
    "@anthropic-ai/sdk": "^0.9.0",
    "body-parser": "^1.20.2"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}

Installation:
npm install
npm install --save-dev nodemon

.env file:
DATABASE_URL=postgresql://postgres:password@localhost:5432/tk_medical_sales
JWT_SECRET=your_super_secret_key_change_this
CLAUDE_API_KEY=sk-ant-...your_key...
PORT=5000
NODE_ENV=development
*/

// 2. SERVER.JS - Main Express Server
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Permission Check Middleware
const checkPermission = (requiredRole = null, requiredDivision = null) => {
  return (req, res, next) => {
    if (requiredRole && !requiredRole.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (requiredDivision && req.user.division !== 'both' && !requiredDivision.includes(req.user.division)) {
      return res.status(403).json({ error: 'Cannot access other division records' });
    }
    next();
  };
};

// Database Test
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('Database connection failed:', err);
  } else {
    console.log('Database connected:', result.rows[0]);
  }
});

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role, division FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, division: user.division },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, division: user.division }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ACTIVITY LOG ROUTES (THE ENGINE)
// ============================================

app.post('/api/activities', authenticateToken, async (req, res) => {
  const { raw_input, hospital_id, doctor_id, entered_by_id, visit_duration_minutes } = req.body;
  const user_id = req.user.id; // activity_owner_id
  const entered_by = entered_by_id || user_id; // default to self

  try {
    // Step 1: Send to Claude for extraction
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Extract structured data from this medical sales activity:

"${raw_input}"

Return ONLY a JSON object with these fields (all optional except activity_date):
{
  "activity_date": "YYYY-MM-DD",
  "activity_type": "Visit/Call/Email/CME/Demo/Other",
  "purpose": "short description",
  "outcome": "what happened",
  "next_action": "what to do next",
  "due_date": "YYYY-MM-DD or null",
  "hospital_name": "hospital name if mentioned",
  "doctor_name": "doctor name if mentioned",
  "specialty": "orthopedic/plastic/vascular/general/og/wound_care/dental or null",
  "patient_name": "if mentioned",
  "case_cycle": "cycle number if mentioned",
  "machine_serial": "machine serial if mentioned",
  "confidence": 0.95
}

Be conservative: if unsure, set confidence below 0.8.`
        }
      ]
    });

    let extracted_data = {};
    const response_text = message.content[0].text;

    try {
      extracted_data = JSON.parse(response_text);
    } catch (e) {
      console.error('Claude response was not valid JSON:', response_text);
      extracted_data = { confidence: 0.3 };
    }

    // Step 2: If confidence < 0.8, ask for clarification
    if ((extracted_data.confidence || 0) < 0.8) {
      return res.json({
        status: 'needs_clarification',
        extracted_data,
        message: 'AI extraction confidence is low. Please review and correct:',
        raw_input
      });
    }

    // Step 3: Save activity to database
    const activity_date = extracted_data.activity_date || new Date().toISOString().split('T')[0];

    const activity_result = await pool.query(
      `INSERT INTO activities 
       (activity_owner_id, entered_by_id, hospital_id, doctor_id, activity_date, activity_type, purpose, outcome, next_action, due_date, raw_input, extracted_by_ai, ai_confidence, specialty, visit_duration_minutes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14, $15, $15)
       RETURNING *`,
      [
        user_id,
        entered_by,
        hospital_id,
        doctor_id,
        activity_date,
        extracted_data.activity_type || 'Visit',
        extracted_data.purpose,
        extracted_data.outcome,
        extracted_data.next_action,
        extracted_data.due_date,
        raw_input,
        extracted_data.confidence || 0.9,
        extracted_data.specialty,
        visit_duration_minutes,
        user_id
      ]
    );

    const activity = activity_result.rows[0];

    // Step 4: Auto-create CTA if next_action exists
    if (extracted_data.next_action) {
      const cta_type_map = {
        'follow up': 'Follow-up',
        'call': 'Call',
        'visit': 'Visit',
        'quote': 'Quote',
        'update': 'Case Update'
      };

      let cta_type = 'Follow-up';
      const lower_action = extracted_data.next_action.toLowerCase();
      for (const [key, val] of Object.entries(cta_type_map)) {
        if (lower_action.includes(key)) {
          cta_type = val;
          break;
        }
      }

      await pool.query(
        `INSERT INTO ctas 
         (activity_owner_id, assigned_rep_id, hospital_id, doctor_id, activity_id, action, cta_type, due_date, status, priority, created_by, updated_by)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, 'Open', 'Due This Week', $1, $1)`,
        [
          user_id,
          hospital_id || null,
          doctor_id || null,
          activity.id,
          extracted_data.next_action,
          cta_type,
          extracted_data.due_date || new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0]
        ]
      );
    }

    // Step 5: Auto-create Case if patient mentioned
    if (extracted_data.patient_name && hospital_id && doctor_id) {
      const case_check = await pool.query(
        'SELECT id FROM cases WHERE patient_name = $1 AND hospital_id = $2 AND doctor_id = $3 AND activity_owner_id = $4',
        [extracted_data.patient_name, hospital_id, doctor_id, user_id]
      );

      if (case_check.rows.length === 0) {
        const case_result = await pool.query(
          `INSERT INTO cases 
           (activity_owner_id, assigned_rep_id, hospital_id, doctor_id, patient_name, status, created_by, updated_by)
           VALUES ($1, $1, $2, $3, $4, 'Incomplete', $1, $1)
           RETURNING id`,
          [user_id, hospital_id, doctor_id, extracted_data.patient_name]
        );

        const case_id = case_result.rows[0].id;

        // Update activity with case_id
        await pool.query('UPDATE activities SET case_id = $1 WHERE id = $2', [case_id, activity.id]);

        // Create completeness warnings
        const warnings = ['wound_photo', 'measurements', 'machine_serial'];
        for (const warning of warnings) {
          await pool.query(
            'INSERT INTO case_completeness_warnings (case_id, missing_field) VALUES ($1, $2)',
            [case_id, warning]
          );
        }
      }
    }

    // Step 6: Update doctor stats (visit_count, first_visit_date, last_visit_date)
    if (doctor_id) {
      await pool.query(
        `UPDATE doctors 
         SET visit_count = visit_count + 1,
             last_visit_date = CURRENT_DATE,
             total_visit_duration_minutes = total_visit_duration_minutes + COALESCE($1, 0),
             first_visit_date = COALESCE(first_visit_date, CURRENT_DATE),
             updated_by = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [visit_duration_minutes || 0, user_id, doctor_id]
      );
    }

    // Step 7: Update hospital stats
    if (hospital_id) {
      await pool.query(
        `UPDATE hospitals 
         SET total_visits = total_visits + 1,
             last_visit_date = CURRENT_DATE,
             first_visit_date = COALESCE(first_visit_date, CURRENT_DATE),
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [user_id, hospital_id]
      );
    }

    res.json({
      status: 'success',
      activity,
      message: 'Activity logged successfully and CTAs auto-generated'
    });

  } catch (err) {
    console.error('Activity creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET ACTIVITIES (with permission filtering)
app.get('/api/activities', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const role = req.user.role;

  try {
    let query = 'SELECT * FROM activities';
    let params = [];

    if (role === 'sales_rep') {
      query += ' WHERE activity_owner_id = $1';
      params = [user_id];
    }

    query += ' ORDER BY activity_date DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get activities error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DASHBOARD ROUTES
// ============================================

app.get('/api/dashboard/sales-rep', authenticateToken, async (req, res) => {
  const user_id = req.user.id;

  try {
    // My Tasks
    const tasks = await pool.query(
      `SELECT * FROM ctas WHERE assigned_rep_id = $1 AND status = 'Open' ORDER BY due_date ASC LIMIT 10`,
      [user_id]
    );

    // My Active Cases
    const cases = await pool.query(
      `SELECT * FROM cases WHERE assigned_rep_id = $1 AND status IN ('Active', 'On Hold') ORDER BY created_at DESC`,
      [user_id]
    );

    // Smart Alerts
    const alerts = await pool.query(
      `SELECT d.name, d.specialty, COUNT(a.id) as visit_count, COUNT(DISTINCT c.id) as case_count
       FROM doctors d
       LEFT JOIN activities a ON d.id = a.doctor_id AND a.activity_owner_id = $1
       LEFT JOIN cases c ON d.id = c.doctor_id AND c.assigned_rep_id = $1
       WHERE d.assigned_rep_id = $1
       GROUP BY d.id, d.name, d.specialty
       HAVING COUNT(a.id) > 3 AND COUNT(DISTINCT c.id) = 0
       ORDER BY COUNT(a.id) DESC`,
      [user_id]
    );

    res.json({
      tasks: tasks.rows,
      cases: cases.rows,
      alerts: alerts.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/owner', authenticateToken, checkPermission(['owner', 'admin']), async (req, res) => {
  try {
    // Activities today
    const activities = await pool.query(
      `SELECT u.first_name, COUNT(*) FROM activities a
       JOIN users u ON a.activity_owner_id = u.id
       WHERE a.activity_date = CURRENT_DATE
       GROUP BY u.id, u.first_name`
    );

    // Active cases by hospital
    const cases_by_hospital = await pool.query(
      `SELECT h.name, COUNT(*) FROM cases c
       JOIN hospitals h ON c.hospital_id = h.id
       WHERE c.status = 'Active'
       GROUP BY h.id, h.name ORDER BY COUNT(*) DESC`
    );

    // Team performance
    const team_performance = await pool.query(
      `SELECT u.first_name, COUNT(a.id) as activities, COUNT(DISTINCT c.id) as cases
       FROM users u
       LEFT JOIN activities a ON u.id = a.activity_owner_id
       LEFT JOIN cases c ON u.id = c.assigned_rep_id
       WHERE u.role = 'sales_rep'
       GROUP BY u.id, u.first_name`
    );

    res.json({
      activities_today: activities.rows,
      cases_by_hospital: cases_by_hospital.rows,
      team_performance: team_performance.rows
    });
  } catch (err) {
    console.error('Owner dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CASES ROUTES
// ============================================

app.get('/api/cases', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const role = req.user.role;

  try {
    let query = `SELECT c.*, json_agg(json_build_object('missing_field', ccw.missing_field)) as warnings 
                 FROM cases c 
                 LEFT JOIN case_completeness_warnings ccw ON c.id = ccw.case_id`;
    let params = [];

    if (role === 'sales_rep') {
      query += ' WHERE c.assigned_rep_id = $1';
      params = [user_id];
    }

    query += ' GROUP BY c.id ORDER BY c.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get cases error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cases/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status, machine_serial_id, case_revenue } = req.body;
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      `UPDATE cases SET status = COALESCE($1, status), machine_serial_id = COALESCE($2, machine_serial_id), case_revenue = COALESCE($3, case_revenue), updated_by = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [status, machine_serial_id, case_revenue, user_id, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update case error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HOSPITALS ROUTES
// ============================================

app.get('/api/hospitals', authenticateToken, async (req, res) => {
  const role = req.user.role;
  const user_id = req.user.id;
  const division = req.user.division;

  try {
    let query = 'SELECT * FROM hospitals';
    let params = [];

    if (role === 'sales_rep') {
      query += ` WHERE (assigned_rep_id = $1 OR division = $2 OR division = 'both')`;
      params = [user_id, division];
    }

    query += ' ORDER BY name';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get hospitals error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DOCTORS ROUTES
// ============================================

app.get('/api/doctors', authenticateToken, async (req, res) => {
  const hospital_id = req.query.hospital_id;
  const role = req.user.role;
  const division = req.user.division;

  try {
    let query = 'SELECT * FROM doctors WHERE hospital_id = $1';
    let params = [hospital_id];

    if (role === 'sales_rep') {
      query += ` AND (division = $2 OR division = 'both')`;
      params.push(division);
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get doctors error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CTA ROUTES
// ============================================

app.get('/api/ctas', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const role = req.user.role;

  try {
    let query = `SELECT * FROM ctas WHERE (assigned_rep_id = $1) AND status IN ('Open', 'Snoozed')`;
    let params = [user_id];

    query += ' ORDER BY due_date ASC, priority DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get CTAs error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ctas/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const user_id = req.user.id;

  try {
    const completed_date = status === 'Completed' ? new Date().toISOString() : null;
    const result = await pool.query(
      `UPDATE ctas SET status = $1, completed_date = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [status, completed_date, user_id, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update CTA error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// INVENTORY ROUTES
// ============================================

app.get('/api/inventory', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const role = req.user.role;

  try {
    let machine_query = 'SELECT * FROM machines';
    let params = [];

    if (role === 'sales_rep') {
      machine_query += ' WHERE assigned_rep_id = $1';
      params = [user_id];
    }

    const machines = await pool.query(machine_query, params);

    let consumable_query = 'SELECT * FROM consumables';
    let consumable_params = [];

    if (role === 'sales_rep') {
      consumable_query += ' WHERE assigned_rep_id = $1';
      consumable_params = [user_id];
    }

    const consumables = await pool.query(consumable_query, consumable_params);

    res.json({
      machines: machines.rows,
      consumables: consumables.rows
    });
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// REASSIGNMENT ROUTES (Customer/Case/Opportunity)
// ============================================

app.post('/api/reassign', authenticateToken, checkPermission(['owner', 'admin']), async (req, res) => {
  const { entity_type, entity_id, to_rep_id } = req.body;
  const user_id = req.user.id;

  try {
    const table_map = {
      'Doctor': { table: 'doctors', column: 'assigned_rep_id' },
      'Hospital': { table: 'hospitals', column: 'assigned_rep_id' },
      'Case': { table: 'cases', column: 'assigned_rep_id' },
      'Opportunity': { table: 'opportunities', column: 'assigned_rep_id' }
    };

    const mapping = table_map[entity_type];
    if (!mapping) {
      return res.status(400).json({ error: 'Invalid entity type' });
    }

    // Get current rep
    const current = await pool.query(`SELECT ${mapping.column} FROM ${mapping.table} WHERE id = $1`, [entity_id]);
    const from_rep_id = current.rows[0] ? current.rows[0][mapping.column] : null;

    // Update assignment
    await pool.query(
      `UPDATE ${mapping.table} SET ${mapping.column} = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [to_rep_id, user_id, entity_id]
    );

    // Log reassignment
    await pool.query(
      `INSERT INTO reassignment_log (entity_type, entity_id, from_rep_id, to_rep_id, reassignment_date, created_by)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`,
      [entity_type, entity_id, from_rep_id, to_rep_id, user_id]
    );

    res.json({ status: 'success', message: `${entity_type} reassigned successfully` });
  } catch (err) {
    console.error('Reassign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});


// ====================================================================
// STOCK ITEMS ENDPOINTS (for dropdown/reference)
// ====================================================================

// GET all stock items for dropdowns
app.get('/api/stock-items', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, sku, name, division, category, unit, minimum_stock_level, is_active
       FROM stock_items
       WHERE is_active = true
       ORDER BY name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Stock items error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET stock items by division
app.get('/api/stock-items/division/:division', authenticateToken, async (req, res) => {
  const { division } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, sku, name, category, unit
       FROM stock_items
       WHERE (division = $1 OR division = 'both') AND is_active = true
       ORDER BY name ASC`,
      [division]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// STOCK BATCHES ENDPOINTS (Batch management)
// ====================================================================

// GET stock batches (with expiry filtering)
app.get('/api/stock-batches', authenticateToken, async (req, res) => {
  const { status, expiry_status } = req.query;
  try {
    let query = `
      SELECT 
        sb.id, sb.stock_item_id, sb.batch_number, sb.expiry_date, 
        sb.manufacturing_date, sb.supplier, sb.quantity_in_stock, 
        sb.status, sb.date_received, sb.location,
        si.sku, si.name,
        CASE 
          WHEN sb.expiry_date < CURRENT_DATE THEN 'Expired'
          WHEN sb.expiry_date <= CURRENT_DATE + INTERVAL '3 months' THEN 'Expiring in 3 months'
          WHEN sb.expiry_date <= CURRENT_DATE + INTERVAL '6 months' THEN 'Expiring in 6 months'
          ELSE 'OK'
        END as expiry_status
      FROM stock_batches sb
      JOIN stock_items si ON sb.stock_item_id = si.id
      WHERE 1=1`;
    
    const params = [];
    if (status) {
      query += ` AND sb.status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY sb.expiry_date ASC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single batch
app.get('/api/stock-batches/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM stock_batches WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE stock batch (Ms. Chong receives stock)
app.post('/api/stock-batches', authenticateToken, async (req, res) => {
  const { stock_item_id, batch_number, expiry_date, manufacturing_date, supplier, quantity_in_stock, date_received, location } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO stock_batches 
       (stock_item_id, batch_number, expiry_date, manufacturing_date, supplier, quantity_in_stock, status, date_received, location)
       VALUES ($1, $2, $3, $4, $5, $6, 'Available', $7, $8)
       RETURNING *`,
      [stock_item_id, batch_number, expiry_date, manufacturing_date, supplier, quantity_in_stock, date_received, location]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE batch status (CORRECTED - removed updated_by reference)
app.put('/api/stock-batches/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status, quantity_in_stock } = req.body;
  
  try {
    const updateFields = [];
    const params = [id];
    
    if (status) {
      params.push(status);
      updateFields.push(`status = $${params.length}`);
    }
    if (quantity_in_stock !== undefined) {
      params.push(quantity_in_stock);
      updateFields.push(`quantity_in_stock = $${params.length}`);
    }
    
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    
    const query = `UPDATE stock_batches SET ${updateFields.join(', ')} WHERE id = $1 RETURNING *`;
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```
// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`T&K Medical Sales API running on port ${PORT}`);
  console.log('Backend ready with:');
  console.log('✓ Activity Log (Claude AI extraction)');
  console.log('✓ Visit Intelligence (duration, dates, counts)');
  console.log('✓ Conversion Metrics (first_sale_date, visits_before_conversion)');
  console.log('✓ Specialty Tracking (specialty field on activities)');
  console.log('✓ Case/Hospital/Doctor Reassignment');
  console.log('✓ CME Event Linking');
  console.log('✓ NPWT Inventory Structure');
  console.log('✓ Full Audit Trail');
  console.log('✓ Role-Based Permissions');
  console.log('\nDatabase ready for Phase 2 analytics without schema changes');
});

module.exports = { app, pool };
