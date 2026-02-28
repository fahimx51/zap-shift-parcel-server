const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin Setup
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection Setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3zrlwhd.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// Global Collection Variables
let parcelCollection, paymentCollection, usersCollection, ridersCollection;

// --- LAZY CONNECTION MIDDLEWARE ---
// This ensures DB is connected before ANY route runs
const ensureDB = async (req, res, next) => {
    try {
        if (!parcelCollection || !paymentCollection || !usersCollection || !ridersCollection) {
            await client.connect();
            const db = client.db('parcelDB');
            parcelCollection = db.collection('parcels');
            paymentCollection = db.collection('payments');
            usersCollection = db.collection('users');
            ridersCollection = db.collection('riders');
            console.log("Lazy Connection Successful");
        }
        next();
    } catch (error) {
        res.status(500).send({ message: "Database connection failed", error: error.message });
    }
};

// Apply lazy connection to all routes
app.use(ensureDB);

// --- Custom Middlewares ---

const verifyFBToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send({ message: 'unauthorized access' });
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).send({ message: 'unauthorized access' });

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
    } catch (error) {
        return res.status(403).send({ message: 'forbidden access' });
    }
};

const verifyAdmin = async (req, res, next) => {
    const email = req.decoded.email;
    const user = await usersCollection.findOne({ email });
    if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access from verify admin' });
    }
    next();
};

// --- API Routes ---

app.get('/', (req, res) => {
    res.send("<h1>Hello From Server!</h1>");
});

// Riders API
app.get('/riders/pending', async (req, res) => {
    const query = { status: 'pending' };
    const result = await ridersCollection.find(query).toArray();
    res.send(result);
});

app.get('/riders/active', verifyFBToken, async (req, res) => {
    const query = { status: 'accepted' };
    const result = await ridersCollection.find(query).toArray();
    res.send(result);
});

app.patch('/riders/:id', async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: status } }
    );
    res.send(result);
});

// Users API
app.post('/users', async (req, res) => {
    const { email } = req.body;
    const userExist = await usersCollection.findOne({ email });
    if (userExist) return res.status(200).send({ message: 'User already exist', inserted: 'false' });
    const result = await usersCollection.insertOne(req.body);
    res.send(result);
});

app.get('/users/search', verifyFBToken, async (req, res) => {
    const searchEmail = req.query.email || '';
    const query = { email: { $regex: searchEmail, $options: 'i' } };
    const users = await usersCollection.find(query).project({ email: 1, role: 1, photoURL: 1 }).limit(10).toArray();
    res.send(users);
});

app.get('/users/role/:email', verifyFBToken, async (req, res) => {
    const user = await usersCollection.findOne({ email: req.params.email });
    res.send({ role: user?.role || 'user' });
});

// Parcels API
app.get('/parcels', verifyFBToken, async (req, res) => {
    const query = req.query.email ? { senderEmail: req.query.email } : {};
    const result = await parcelCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(result);
});

app.post('/parcels', async (req, res) => {
    const newParcel = req.body;
    newParcel.createdAt = new Date();
    const result = await parcelCollection.insertOne(newParcel);
    res.status(201).send(result);
});

// Payment API
app.post("/create-payment-intent", async (req, res) => {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
        amount: parseInt(amount * 100),
        currency: "bdt",
        payment_method_types: ["card"],
    });
    res.send({ clientSecret: paymentIntent.client_secret });
});

app.post('/payments', async (req, res) => {
    const payment = req.body;
    payment.date = new Date();
    const paymentResult = await paymentCollection.insertOne(payment);
    const updateResult = await parcelCollection.updateOne(
        { _id: new ObjectId(payment.parcelId) },
        { $set: { payment: 'paid', transactionId: payment.transactionId } }
    );
    res.send({ paymentResult, updateResult });
});

// Server Listen
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});

module.exports = app;