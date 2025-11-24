# TFAR Application Duplication Guide
## Complete Documentation for Creating a Custom Instance

---

## 1. PROJECT OVERVIEW & TECHNOLOGY STACK

### Application Name & Type
- **Current App**: TFAR (Técnico de Farmacia - Oposiciones Online)
- **Purpose**: AI-powered exam preparation system for pharmacy technician professional exams
- **Base URL**: https://farmaboost.org (in .env.example)

### Core Technology Stack
```
Frontend:
- HTML5 + Vanilla JavaScript (no frameworks)
- CSS3 with inline styles
- jsPDF library for PDF export (CDN: https://cdnjs.cloudflare.com/ajax/libs/jspdf/)

Backend:
- Node.js + Express.js (server.js - 3400+ lines)
- SQLite3 (better-sqlite3) for data persistence
- Session management: express-session with SQLiteStore
- Authentication: bcrypt for password hashing

AI/API:
- Anthropic Claude API (@anthropic-ai/sdk v^0.24.3)
- Model: claude-haiku-4-5-20251001 (fast, cost-effective)
- Rate limiting: express-rate-limit

Deployment:
- PM2 for process management (ecosystem.config.js)
- Clustering: 2 workers for 2vCPU
- Security: Helmet.js for headers
- CORS configuration for cross-origin requests

Package Manager: npm with package-lock.json
```

---

## 2. API KEY CONFIGURATION

### Location: Environment Variables (.env file)
**File**: `/home/user/TFAR/.env.example`

```
# API Key Configuration
ANTHROPIC_API_KEY=tu_api_key_aqui

# Server Configuration
PORT=3000
NODE_ENV=development
SESSION_SECRET=oposiciones-secret-key-change-in-production

# Authentication
ADMIN_PASSWORD=admin123

# Domain Configuration (CORS)
ALLOWED_ORIGINS=https://farmaboost.org,https://www.farmaboost.org
```

### Key Locations in Code:
- **API Initialization** (server.js, line 179-181):
  ```javascript
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  ```

- **Claude Model** (server.js, line 369):
  ```javascript
  model: "claude-haiku-4-5-20251001"
  ```

### Variables to Change for Duplication:
1. `ANTHROPIC_API_KEY` - Replace with your own API key
2. `PORT` - Can stay 3000 or change based on deployment
3. `SESSION_SECRET` - MUST change in production
4. `ADMIN_PASSWORD` - Change default password
5. `ALLOWED_ORIGINS` - Update to your domain(s)

---

## 3. CONTENT/TEMARIO STORAGE STRUCTURE

### Directory Structure
```
/documents/                                    # Content files directory
├── TEMA 4- ORGANIZACIONES FARMACEUTICAS.txt
├── TEMA 5- MEDICAMENTOS.txt
├── TEMA 6- FORMULAS MAGISTRALES...txt
├── TEMA 7- ACONDICIONAMIENTO...txt
├── TEMA 8- FARMACOCINETICA...txt
├── TEMA 9- ADMINISTRACION...txt
├── TEMA 10- FORMAS FARMACEUTICAS...txt
├── TEMA 11- FARMACIA HOSPITALARIA.txt
├── TEMA-12-ALMACENAMIENTO...txt
├── TEMA-13-LABORATORIO...txt
├── TEMA-13-2ª-parte-LABORATORIO...txt
├── TEMA-14-OPERACIONES...txt
├── TEMA-14-2ª-parte-LABORATORIO...txt
├── TEMA-15-ANALISIS-CLINICOS.txt
├── TEMA-17-ESPECTROFOTOMETRIA...txt
└── TEMA-18-PARAFARMACIA.txt
```

**Total**: 16 content files (multiple topics/parts)
**Format**: Plain text (.txt files)
**Size**: 68KB to 192KB per file

### How Content is Configured
**File**: `/home/user/TFAR/server.js`, lines 256-338

```javascript
const TOPIC_CONFIG = {
  "tema-4-organizaciones-farmaceuticas": {
    "title": "TEMA 4 - ORGANIZACIONES FARMACEUTICAS",
    "description": "Organizaciones Farmacéuticas",
    "files": ["TEMA 4- ORGANIZACIONES FARMACEUTICAS.txt"]
  },
  // ... 15 more topics configured similarly
};
```

### Content Reading Logic
**File**: `server.js`, line 184
```javascript
const DOCUMENTS_DIR = path.join(__dirname, 'documents');
```

**File Processing** (lines 1115-1140):
- Reads `.txt` files from documents directory
- Chunks content by 1200 characters (~480 tokens)
- Used as context for Claude prompt calls

### Steps to Replace Content:
1. Remove old TEMA files from `/documents/`
2. Add your new content as `.txt` files
3. Update `TOPIC_CONFIG` object in `server.js` with:
   - `tema-id` (key)
   - `title` (display name)
   - `description` (short description)
   - `files` array (list of .txt files to use)
4. Match file names exactly

---

## 4. PROMPT DEFINITIONS & AI CONFIGURATION

### Prompt System Architecture
**Location**: `server.js`, lines 948-1110

Three difficulty levels with separate prompts:

#### 1. SIMPLE PROMPT (20% of generation)
**Lines**: 948-1001
```javascript
const CLAUDE_PROMPT_SIMPLE = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.
OBJETIVO: Genera 2 preguntas SIMPLES...`
```

Key characteristics:
- 2 questions per call
- Evaluates memorization of objective data
- Temperature: 0.3 (deterministic)
- Max tokens: 600
- Price per question: ~$0.000555 USD

#### 2. MEDIA PROMPT (60% of generation)
**Lines**: 1004-1054
```javascript
const CLAUDE_PROMPT_MEDIA = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.
OBJETIVO: Genera 2 preguntas MEDIAS...`
```

Key characteristics:
- 2 questions per call
- Evaluates comprehension and application
- 15 question types for variety
- Temperature: 0.5 (balanced)
- Max tokens: 800
- Price per question: ~$0.000683 USD

#### 3. ELABORADA PROMPT (20% of generation)
**Lines**: 1057-1110
```javascript
const CLAUDE_PROMPT_ELABORADA = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.
OBJETIVO: Genera 2 preguntas ELABORADAS...`
```

Key characteristics:
- 2 questions per call
- Evaluates deep analysis and reasoning
- 10 complex scenario types
- Temperature: 0.7 (creative)
- Max tokens: 1000
- Price per question: ~$0.001264 USD

### Temperature Configuration
**File**: `server.js`, lines 195-199
```javascript
const TEMPERATURE_CONFIG = {
  'simple': 0.3,      // More deterministic
  'media': 0.5,       // Balanced
  'elaborada': 0.7    // More creative
};
```

### Claude Configuration
**File**: `server.js`, lines 186-193
```javascript
const IMPROVED_CLAUDE_CONFIG = {
  maxRetries: 3,              // Retry up to 3 times
  baseDelay: 1500,            // 1.5 second initial delay
  maxDelay: 8000,             // Maximum 8 seconds
  backoffMultiplier: 2,       // Exponential backoff
  jitterFactor: 0.1           // 10% jitter
};
```

### How Prompts are Used
1. **Pre-warming** (line 2187): `/api/study/pre-warm` - Generate 2-3 questions proactively
2. **Study Mode** (line 2254): `/api/study/question` - Get single question on demand
3. **Exam Generation** (line 1741): `/api/generate-exam` - Generate full 100-question exam

### Critical Prompt Changes for Duplication:
- Replace "OPOSICIONES Técnico Farmacia SERGAS" with your exam name
- Update referenced regulations/standards (RD 1345/2007, Ley 29/2006, etc.)
- Modify example questions and answer styles
- Adjust difficulty level instructions for your content domain

---

## 5. DEPLOYMENT CONFIGURATION FILES

### PM2 Configuration (Clustering)
**File**: `/home/user/TFAR/ecosystem.config.js`

```javascript
module.exports = {
  apps: [{
    name: 'oposicion-app',              // App name for PM2
    script: './server.js',
    instances: 2,                        // 2 workers for 2vCPU
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    max_memory_restart: '500M',          // Restart if >500MB
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
  }]
};
```

**For Duplication**: Update `name` field to match your app

### Package Configuration
**File**: `/home/user/TFAR/package.json`

```json
{
  "name": "oposiciones-app",                    // Change this
  "version": "1.0.0",
  "description": "Sistema inteligente de preparación de oposiciones técnicas",  // Change
  "main": "server.js",
  "keywords": ["oposiciones", "examenes", "claude", "ai", "justicia"],  // Update
  "author": "Tu Nombre"                        // Update
}
```

### Environment File Template
**File**: `/home/user/TFAR/.env.example`

Create your own `.env` file (not in git) with:
```
ANTHROPIC_API_KEY=[your_key_here]
PORT=3000
SESSION_SECRET=[random_string_for_production]
ADMIN_PASSWORD=[secure_password]
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### Database Initialization
**File**: `database.js` (line 10)
```javascript
const dbPath = path.join(__dirname, 'oposiciones.db');
```

This creates SQLite database at `./oposiciones.db` automatically on first run.
No manual database configuration needed.

---

## 6. ENVIRONMENT VARIABLES & SETTINGS

### Complete Environment Variable Reference

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude API authentication | Required | `sk-ant-...` |
| `PORT` | Server port | 3000 | 3000, 8080 |
| `NODE_ENV` | Environment mode | development | development, production |
| `SESSION_SECRET` | Session encryption key | oposiciones-secret... | Long random string |
| `ADMIN_PASSWORD` | Admin panel password | admin123 | Strong password |
| `ALLOWED_ORIGINS` | CORS allowed domains | Empty (allow all) | https://domain.com |
| `ADMIN_CONTACT` | Admin contact info | "Contacta al administrador" | email@domain.com |

### Configuration in Code:

**CORS Setup** (server.js, lines 89-91):
```javascript
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
```

**Session Configuration** (server.js, lines 68-83):
```javascript
app.use(session({
  secret: process.env.SESSION_SECRET || 'oposiciones-secret-key-change-in-production',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in production
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));
```

**Admin Authentication** (server.js, lines 1319-1334):
```javascript
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = req.headers['x-admin-password'];
  
  if (providedPassword !== (adminPassword || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

### Rate Limiting Configuration (server.js, lines 124-162):
- **Global**: 300 requests per 15 minutes per IP
- **Authentication**: 10 attempts per 15 minutes
- **Exam Generation**: 30 exams per hour per user
- **Study Mode**: 100 questions per hour per user

---

## 7. DATABASE & DATA PERSISTENCE

### Database Engine: SQLite3
**File**: `database.js` (Lines 1-20)

### Database File Location
```
./oposiciones.db     # Created automatically on startup
./sessions.db        # Session storage (created by express-session)
```

### Database Schema (10 Tables)

#### 1. **users** - User accounts
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  estado TEXT DEFAULT 'bloqueado',           -- 'activo' or 'bloqueado'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_access DATETIME DEFAULT CURRENT_TIMESTAMP,
  active_sessions TEXT DEFAULT '[]'          -- JSON array of session IDs
)
```

#### 2. **user_stats** - Performance per topic
```sql
CREATE TABLE IF NOT EXISTS user_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  topic_title TEXT NOT NULL,
  total_questions INTEGER DEFAULT 0,
  correct_answers INTEGER DEFAULT 0,
  accuracy INTEGER DEFAULT 0,                -- Percentage 0-100
  last_studied DATETIME,
  UNIQUE(user_id, topic_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

#### 3. **failed_questions** - Questions user got wrong
```sql
CREATE TABLE IF NOT EXISTS failed_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,                     -- JSON array
  correct INTEGER NOT NULL,                  -- Index 0-3
  user_answer INTEGER,                       -- Index 0-3 or NULL
  explanation TEXT,
  difficulty TEXT,                           -- 'simple', 'media', 'elaborada'
  page_reference TEXT,
  date DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

#### 4. **activity_log** - User activity tracking
```sql
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL,               -- 'question_answered', 'exam_generated', etc.
  topic_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

#### 5. **chunk_usage** - Track used content chunks
```sql
CREATE TABLE IF NOT EXISTS chunk_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, topic_id, chunk_index),
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

#### 6. **question_cache** - Pre-generated questions pool
```sql
CREATE TABLE IF NOT EXISTS question_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_data TEXT NOT NULL,               -- JSON
  difficulty TEXT NOT NULL,                  -- 'simple', 'media', 'elaborada'
  topic_id TEXT NOT NULL,
  generated_at INTEGER NOT NULL,             -- Unix timestamp
  expires_at INTEGER NOT NULL,               -- TTL for cache
  times_used INTEGER DEFAULT 0
)
```

#### 7. **user_seen_questions** - Track viewed questions
```sql
CREATE TABLE IF NOT EXISTS user_seen_questions (
  user_id INTEGER NOT NULL,
  question_cache_id INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  context TEXT,
  PRIMARY KEY (user_id, question_cache_id)
)
```

#### 8. **cache_stats** - Cache hit rate tracking
```sql
CREATE TABLE IF NOT EXISTS cache_stats (
  date TEXT PRIMARY KEY,
  questions_generated INTEGER DEFAULT 0,
  questions_cached INTEGER DEFAULT 0,
  cache_hit_rate REAL DEFAULT 0,
  total_cost_usd REAL DEFAULT 0
)
```

#### 9. **user_question_buffer** - Pre-fetch buffer
```sql
CREATE TABLE IF NOT EXISTS user_question_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  question_data TEXT NOT NULL,               -- JSON
  question_cache_id INTEGER,
  difficulty TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

#### 10. **answer_history** - Weekly stats tracking
```sql
CREATE TABLE IF NOT EXISTS answer_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  topic_title TEXT NOT NULL,
  is_correct INTEGER NOT NULL,               -- 0 or 1
  answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

### Key Indexes for Performance
- `idx_failed_user_topic` - Fast retrieval of failed questions
- `idx_cache_expiry` - Cache cleanup
- `idx_buffer_user_topic` - Question buffer lookups
- `idx_answer_history_user_date` - Weekly statistics

### Data Persistence Features
- **WAL Mode**: Write-Ahead Logging for better concurrency (supports 200+ users)
- **Foreign Keys**: Enforced referential integrity
- **Automatic Cleanup**: Expired cache/buffer cleaned every 30 minutes
- **No Manual Migrations**: Database schema created automatically

---

## 8. HARDCODED REFERENCES TO TFAR & BRANDING

### Files Containing Branding References:

#### A. `server.js` - Multiple hardcoded references:
- **Lines 948, 1004, 1057**: Prompts reference "OPOSICIONES Técnico Farmacia SERGAS"
- **Line 1442**: Message "SERVIDOR DE OPOSICIONES ONLINE"
- **Line 2447**: Pre-generation message references "oposiciones"

#### B. `package.json`:
- **Line 2**: `"name": "oposiciones-app"`
- **Line 4**: `"description": "Sistema inteligente de preparación de oposiciones técnicas"`
- **Lines 30-34**: Keywords include "oposiciones", "examenes", "justicia"

#### C. `public/index.html`:
- **Line 6**: `<title>Oposicion Tecnico Farmacia</title>`
- **Line 1084**: `<span class="emoji">📚</span>Técnicos de Farmacia`
- Throughout: Colors and styling (#f97316 orange theme)

#### D. `public/admin.html`:
- **Line 6**: `<title>Panel de Administración - Oposiciones</title>`
- **Line 490**: `<h1>🔐 Admin Panel</h1>`

#### E. `ecosystem.config.js`:
- **Line 9**: `name: 'oposicion-app'`

#### F. `.env.example`:
- **Line 35**: `ALLOWED_ORIGINS=https://farmaboost.org,https://www.farmaboost.org`

### Steps to Replace All Branding:

1. **Search & Replace in `server.js`**:
   - Replace: `"OPOSICIONES Técnico Farmacia SERGAS"` 
   - With: `"Your Exam Name"`
   - Replace: `"SERVIDOR DE OPOSICIONES ONLINE"` 
   - With: `"Your App Server"`

2. **Update `package.json`**:
   ```json
   {
     "name": "your-app-name",
     "description": "Your app description",
     "keywords": ["keyword1", "keyword2"]
   }
   ```

3. **Update `public/index.html`**:
   - Line 6: Change `<title>`
   - Line 1084: Change header text and emoji
   - Update color theme if desired

4. **Update `public/admin.html`**:
   - Line 6: Change `<title>`

5. **Update `ecosystem.config.js`**:
   - Line 9: Change app `name`

6. **Create `.env` file**:
   - Update `ALLOWED_ORIGINS` for your domain(s)
   - Update `ADMIN_PASSWORD`
   - Update `SESSION_SECRET`

---

## 9. API ENDPOINTS REFERENCE

### Authentication Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Authenticate user |
| POST | `/api/auth/logout` | Logout user |
| GET | `/api/auth/check` | Check authentication status |

### Study Mode Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/topics` | List all topics |
| POST | `/api/study/pre-warm` | Pre-generate questions for buffer |
| POST | `/api/study/question` | Get single question |
| POST | `/api/record-answer` | Record user answer |
| GET | `/api/failed-questions` | Get questions user got wrong |

### Exam Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/generate-exam` | Generate 100-question exam |
| POST | `/api/exam/official` | Generate official exam with timer |
| POST | `/api/exam/save-failed` | Save failed questions from exam |
| POST | `/api/resolve-failed-question` | Get explanation for failed question |
| GET | `/api/review-exam/:topicId` | Review previous exam |

### Statistics Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-stats` | Get overall statistics |
| GET | `/api/weekly-stats` | Get weekly performance data |
| GET | `/api/admin/stats` | Admin: Global statistics |
| GET | `/api/admin/users/:id/activity` | Admin: User activity |

### Admin Endpoints (require X-Admin-Password header)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create new user |
| POST | `/api/admin/users/:id/activate` | Activate user account |
| POST | `/api/admin/users/:id/block` | Block user account |
| POST | `/api/admin/users/block-all` | Block all users |
| GET | `/api/admin/export/user/:id` | Export user data to Excel |
| GET | `/api/admin/export/all` | Export all users to Excel |

### Utility Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Server health check |
| GET | `/api/documents-status` | Check available documents |

---

## 10. COMPLETE DUPLICATION CHECKLIST

### Phase 1: Code Preparation
- [ ] Clone or copy entire TFAR directory
- [ ] Review and understand current technology stack
- [ ] Identify all branding elements to replace
- [ ] Plan new domain and hosting setup

### Phase 2: Content Replacement
- [ ] Prepare new content in .txt format (1-5KB chunks work well)
- [ ] Create list of new topics with IDs and descriptions
- [ ] Clear `/documents/` directory
- [ ] Add new content files
- [ ] Update `TOPIC_CONFIG` in `server.js` with new topics (lines 256-338)

### Phase 3: Prompt Customization
- [ ] Update Claude prompts for your domain:
  - Line 948: CLAUDE_PROMPT_SIMPLE
  - Line 1004: CLAUDE_PROMPT_MEDIA
  - Line 1057: CLAUDE_PROMPT_ELABORADA
- [ ] Change references to regulations/standards
- [ ] Update example questions in prompts
- [ ] Test prompt quality with sample generations

### Phase 4: Branding Updates
- [ ] Update `package.json`: name, description, keywords
- [ ] Update `public/index.html`: title, header text
- [ ] Update `public/admin.html`: title
- [ ] Update `ecosystem.config.js`: app name
- [ ] Choose new color scheme if desired
- [ ] Update emoji/icons for app
- [ ] Update server startup messages in `server.js` (line 1442)

### Phase 5: Configuration
- [ ] Create `.env` file with:
  - [ ] `ANTHROPIC_API_KEY` (get from https://console.anthropic.com/settings/keys)
  - [ ] `PORT` (default 3000 is fine)
  - [ ] `SESSION_SECRET` (generate random string, min 32 chars)
  - [ ] `ADMIN_PASSWORD` (strong password, min 12 chars)
  - [ ] `ALLOWED_ORIGINS` (your domain)
  - [ ] `NODE_ENV` (development or production)
- [ ] Copy `.env.example` to `.env`
- [ ] **DO NOT commit .env to git**

### Phase 6: Database Setup
- [ ] No manual setup needed (created automatically)
- [ ] Ensure write permissions to directory for database files
- [ ] First run will create: `oposiciones.db`, `sessions.db`

### Phase 7: Deployment Preparation
- [ ] Update `ecosystem.config.js` for your infrastructure:
  - Adjust `instances` based on CPU cores
  - Adjust `max_memory_restart` if needed
  - Update timezone if not Europe/Madrid
- [ ] Set up `.gitignore` to exclude:
  - `.env`
  - `*.db` (database files)
  - `logs/`
  - `node_modules/`

### Phase 8: Testing
- [ ] Install dependencies: `npm install`
- [ ] Test locally: `npm start` or `node server.js`
- [ ] Test authentication flow
- [ ] Test question generation (check costs!)
- [ ] Test admin panel with correct password
- [ ] Verify database creation
- [ ] Test CORS with your domain
- [ ] Check all API endpoints

### Phase 9: Deployment
- [ ] Choose hosting platform (Render, Heroku, VPS, etc.)
- [ ] Set environment variables in platform
- [ ] Install Node.js and npm on server
- [ ] Upload code to server
- [ ] Run `npm install --production`
- [ ] Start with PM2: `pm2 start ecosystem.config.js`
- [ ] Configure domain DNS to point to server
- [ ] Set up SSL certificate (HTTPS)
- [ ] Configure backup strategy for database

### Phase 10: Post-Deployment
- [ ] Monitor logs: `pm2 logs`
- [ ] Verify CORS headers working
- [ ] Test production endpoints
- [ ] Set up admin account
- [ ] Create documentation for your admin panel
- [ ] Set up monitoring/alerts
- [ ] Document API key rotation process

---

## 11. COST ANALYSIS (Claude API)

### Per-Question Pricing (based on claude-haiku-4-5)

| Difficulty | % of Gen. | Questions/Call | Avg Cost/Question | Use Case |
|------------|-----------|----------------|-------------------|----------|
| Simple | 20% | 2 | $0.000555 | Memorization |
| Media | 60% | 2 | $0.000683 | Application |
| Elaborada | 20% | 2 | $0.001264 | Analysis |
| **WEIGHTED AVERAGE** | - | - | **$0.000774** | **~$0.77 per 1000 Q** |

### Exam Generation Cost
- 100-question exam: ~$0.077 USD (7 cents)
- Buffer prefetch (2-3 Q): ~$0.002 USD

### Scaling Examples
- 10 users, 1 exam each: ~$0.77
- 100 users, 1 exam each: ~$7.70
- 1000 users, 1 exam each: ~$77.00
- Monthly (1000 users × 2 exams): ~$154

---

## 12. FILES TO MODIFY SUMMARY

### Critical Files (Must Modify)

1. **server.js** (3400+ lines)
   - Lines 256-338: Update `TOPIC_CONFIG` with your topics
   - Lines 948, 1004, 1057: Update Claude prompts
   - Line 1442: Update server startup message
   - Search/Replace: "OPOSICIONES Técnico Farmacia SERGAS" → Your exam name

2. **public/index.html** (2000+ lines)
   - Line 6: Update `<title>`
   - Line 1084: Update header text
   - Optional: Update color scheme

3. **public/admin.html**
   - Line 6: Update `<title>`

4. **package.json**
   - Line 2: Update "name"
   - Line 4: Update "description"
   - Line 30-34: Update "keywords"

5. **ecosystem.config.js**
   - Line 9: Update app "name"

6. **.env** (create new file)
   - All variables customized for your setup

7. **/documents/** (directory)
   - Replace all TEMA*.txt files with your content

### Files to Leave As-Is
- `database.js` (generic, no hardcoding)
- `auto-detect.js`
- `diagnose-weekly-stats.js`
- `test-*.js` (test files)
- `.gitignore`

---

## 13. IMPORTANT SECURITY NOTES

1. **API Key Security**:
   - Never commit `.env` to git
   - Use separate API keys for dev/production
   - Rotate API keys periodically
   - Monitor API usage in Anthropic console

2. **Admin Password**:
   - Change from default "admin123"
   - Use strong password (min 12 chars)
   - Hash is not stored, verify each request

3. **Session Secret**:
   - Use cryptographically secure random string (32+ chars)
   - Different for development and production
   - Change if compromise suspected

4. **CORS Configuration**:
   - Set specific `ALLOWED_ORIGINS` in production
   - Never allow wildcard "*" in production
   - Test with your exact domain

5. **HTTPS**:
   - Always use HTTPS in production
   - Set `NODE_ENV=production` for secure cookies
   - Use SameSite=none only with HTTPS

6. **Database**:
   - Passwords hashed with bcrypt (10 rounds)
   - Regular backups recommended
   - Restrict database file permissions

7. **Rate Limiting**:
   - Prevents brute-force and API abuse
   - Adjust thresholds based on expected user load
   - Monitor for attack patterns

---

## 14. QUICK START SCRIPT TEMPLATE

```bash
#!/bin/bash

# 1. Clone and prepare
cp -r TFAR new-app-name
cd new-app-name
npm install

# 2. Create .env
cat > .env << 'ENVFILE'
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
PORT=3000
NODE_ENV=development
SESSION_SECRET=$(openssl rand -base64 32)
ADMIN_PASSWORD=SecurePassword123!
ALLOWED_ORIGINS=http://localhost:3000
ENVFILE

# 3. Replace content
rm -rf documents/*
cp path/to/your/content/*.txt documents/

# 4. Update branding in server.js
sed -i 's/OPOSICIONES Técnico Farmacia SERGAS/Your Exam Name/g' server.js

# 5. Update branding in package.json
sed -i 's/"name": "oposiciones-app"/"name": "your-app-name"/g' package.json

# 6. Test
npm start

# 7. Deploy with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## 15. ADDITIONAL RESOURCES

### File Locations Quick Reference
```
Root Directory (/home/user/TFAR or your copy)
├── server.js                    # Main application (3400+ lines)
├── database.js                  # SQLite database layer
├── ecosystem.config.js          # PM2 configuration
├── package.json                 # Node dependencies
├── package-lock.json
├── .env                         # Environment variables (CREATE THIS)
├── .env.example                 # Template
├── .gitignore
├── auto-detect.js
├── diagnose-weekly-stats.js
├── public/
│   ├── index.html              # Main application UI
│   └── admin.html              # Admin panel
├── documents/                  # Content files (REPLACE THESE)
│   └── TEMA*.txt
├── logs/                        # Application logs
└── sessions.db                  # Session storage (auto-created)
```

### Important Constants in Code
```javascript
DOCUMENTS_DIR        = './documents'
DATABASE_FILE        = './oposiciones.db'
SESSIONS_FILE        = './sessions.db'
CLAUDDE_MODEL        = 'claude-haiku-4-5-20251001'
DEFAULT_PORT         = 3000
RATE_LIMIT_WINDOW    = 15 minutes (global), 1 hour (exam/study)
SESSION_MAX_AGE      = 7 days
CACHE_TTL            = Various (check database.js)
PRE_WARM_QUESTIONS   = 2-3 questions
```

---

**Document Version**: 1.0
**Created**: 2024
**Based on TFAR Project Structure**

