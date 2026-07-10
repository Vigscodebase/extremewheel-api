import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import mongoose from "mongoose"
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { logToFile } from './logger';
import User from "./models/User.js"

dotenv.config({ debug: true });

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Securely load the private key for the Authentication Service
let privateKey;
try {
    privateKey = fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8');
} catch (err) {
    console.error("CRITICAL: private.pem not found. Please generate RSA keys.");
    process.exit(1);
}

const whitelist = ['http://192.168.2.63:5173'];
const corsOptions = {
    origin: function (origin, callback) {
        if (whitelist.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// Request logger middleware
app.use((req, res, next) => {
    const start = Date.now();
    const route = `${req.method} ${req.originalUrl}`;
    logToFile(`[API] START ${route}`);

    res.on('finish', () => {
        const duration = Date.now() - start;
        const msg = `[API] END   ${route} - ${res.statusCode} (${duration}ms)`;
        logToFile(msg);
    });
    next();
});

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/extremewheel')
    .then(async () => {
        logToFile(`[DB] ✅ Connected to MongoDB`);

        // Explicitly build unique indexes to ensure MongoDB unique constraints are active
        try {
            await User.createIndexes();
            logToFile(`[DB] ✅ User unique indexes verified/created`);
        } catch (idxErr) {
            logToFile(`[DB] ⚠️ Failed to verify User indexes:', ${idxErr.message}`);
        }

        updateScraperConfigFile().then(() => {
            startScraper(); // Start scraper after DB connection and config sync
        });
    })
    .catch(err => logToFile(`[DB] ⚠️ Failed to verify User indexes:', ${err}`));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

const expressURLEncode = express.urlencoded({ extended: true })
const expressJSONBody = express.json()

// Middleware to authenticate token
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
};