const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');

const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);


const app = express();
const port = process.env.PORT || 3000;


const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});



app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3zrlwhd.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();


        //custom middlewares

        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;

            if (!authHeader) {
                return res.status(401).send({ messege: 'unauthorize access' });
            }

            const token = authHeader.split(' ')[1];

            if (!token) {
                return res.status(401).send({ messege: 'unauthorize access' });
            }

            /*
            User have a header also a token
            Now Verify the token
            */
            try {

                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;

                next();
            }

            catch (error) {
                return res.status(403).send({ messege: 'forbidden access' })
            }


        };


        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ messege: 'forbidden access form verify admin' });
            }
            else next();
        };



        // Parcel related API

        const parcelCollection = client.db('parcelDB').collection('parcels');

        app.get('/parcels', verifyFBToken, async (req, res) => {
            const userEmail = req.query.email;
            const query = {};

            if (userEmail) {
                query.senderEmail = userEmail;
            }

            const options = {
                sort: { createdAt: -1 }
            };

            const result = await parcelCollection
                .find(query, options)
                .toArray();

            return res.send(result);
        });

        app.get('/parcels/:id', verifyFBToken, async (req, res) => {
            const id = req.params.id;

            const query = { _id: new ObjectId(id) };

            const result = await parcelCollection.findOne(query);
            res.send(result);
        });

        app.post('/parcels', async (req, res) => {
            try {
                const newParcel = req.body;
                newParcel.createdAt = new Date();
                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            }
            catch {
                console.log("pracels api post failure");
                res.status(501).send({ messege: 'Failed to create parcel' })
            }
        });

        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelCollection.deleteOne(query);
            res.send(result);
        });


        //card payment realated apis

        app.post("/create-payment-intent", async (req, res) => {
            const { amount } = req.body; // e.g., 500

            // Stripe calculates in "cents" or "poisha". 
            // To charge ৳ 500, you must send 500 * 100.
            const totalAmount = parseInt(amount * 100);

            const paymentIntent = await stripe.paymentIntents.create({
                amount: totalAmount,
                currency: "bdt", // Use 'bdt' for Taka or 'usd' for testing
                payment_method_types: ["card"],
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        // Payment related API
        const paymentCollection = client.db('parcelDB').collection('payments');

        app.post('/payments', async (req, res) => {
            const payment = req.body;

            // 1. Save the payment history
            payment.date = new Date();
            payment.dateString = new Date().toISOString();
            const paymentResult = await paymentCollection.insertOne(payment);

            // 2. Update the parcel status in parcelCollection
            const query = { _id: new ObjectId(payment.parcelId) };
            const updatedDoc = {
                $set: {
                    payment: 'paid',
                    transactionId: payment.transactionId
                }
            };
            const updateResult = await parcelCollection.updateOne(query, updatedDoc);

            res.send({ paymentResult, updateResult });
        });

        app.get('/payments', verifyFBToken, async (req, res) => {
            const userEmail = req.query.email;

            console.log('Decoded : ', req.decoded);

            if (req.decoded.email !== userEmail) {
                return res.status(403).send({ messege: 'forbidden access' });
            }

            const query = {};
            const options = {
                sort: { date: -1 }
            };

            if (userEmail) {
                query.email = userEmail;
            }

            const result = await paymentCollection.find(query).toArray();
            res.send(result);
        });


        //users related apis

        const usersCollection = client.db('parcelDB').collection('users');

        app.post('/users', async (req, res) => {
            const { email, role, photoURL, created_at } = req.body;

            const userExist = await usersCollection.findOne({ email });

            if (userExist) {
                return res.status(200).send({ messege: 'User already exist', inserted: 'false' });
            }

            const user = req.body;
            const result = await usersCollection.insertOne(user);

            res.send(result);

        });


        // Search users by partial email
        app.get('/users/search', verifyFBToken, async (req, res) => {
            const searchEmail = req.query.email || '';
            const query = { email: { $regex: searchEmail, $options: 'i' } };

            try {
                const users = await usersCollection
                    .find(query)
                    .sort({ role: 1 })
                    .project({ email: 1, role: 1, photoURL: 1 })
                    .limit(10)
                    .toArray();

                // Always send the array, even if it is empty []
                res.send(users);

            } catch (error) {
                res.status(500).send({ message: 'Server error' });
            }
        });

        //user role update

        app.patch('/users/:id/role', async (req, res) => {
            const id = req.params.id;
            const { role } = req.body;

            if (!['admin', 'user'].includes(role)) {
                return res.status(400).send({ messege: 'invalid role' });
            }

            const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: role } });

            res.send(result);
        });

        // show all user

        // app.get('/users', async (req, res) => {
        //     const result = await usersCollection.find({ role: 'user' }).toArray();
        //     res.send(result);
        // })

        //get user role by email
        app.get('/users/role/:email', verifyFBToken, async (req, res) => {
            const email = req.params.email;
            // console.log("Email : ------", email);
            // Safety check: only let users check their own role

            const user = await usersCollection.findOne({ email: email });
            // If user has no role, default to 'user'
            res.send({ role: user?.role || 'user' });
        });




        // riders related apis

        const ridersCollection = client.db('parcelDB').collection('riders');

        app.post('/riders', async (req, res) => {
            const riderData = req.body;
            riderData.status = 'pending';
            const result = await ridersCollection.insertOne(riderData);

            res.send(result);
        });

        app.get('/riders/pending', async (req, res) => {
            const query = { status: 'pending' };

            const result = await ridersCollection.find(query).toArray();

            res.send(result);
        });

        app.get('/riders/active', verifyFBToken, verifyAdmin, async (req, res) => {
            const query = { status: 'accepted' };

            const result = await ridersCollection.find(query).toArray();

            res.send(result);
        })

        app.patch('/riders/:id', async (req, res) => {
            const id = req.params.id;
            const { status, email } = req.body;

            // console.log(req.body);

            const statusQuery = { _id: new ObjectId(id) };

            const statusUpdateDoc = {
                $set: {
                    status: status
                }
            };

            const result = await ridersCollection.updateOne(statusQuery, statusUpdateDoc)

            res.send(result);
        });



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send("<h1>Hello From Server!</h1>")
})

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`)
})

module.exports = app;