import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from './config/database.js';

// Route imports
import authRoutes from './routes/auth.js';
import hotelRoutes from './routes/hotels.js';
import bookingRoutes from './routes/bookings.js';
import serviceRoutes from './routes/services.js';
import chatRoutes from './routes/chat.js';
import staffRoutes from './routes/staff.js';
import taskRoutes from './routes/tasks.js';
import paymentRoutes from './routes/payments.js';
import serviceCatalogRoutes from './routes/serviceCatalog.js';
import notificationRoutes from './routes/notifications.js';
import uploadRoutes from './routes/upload.js';
import adminRoutes from './routes/admin.js';
import deviceRoutes from './routes/devices.js';
import eventsRoutes from './routes/events.js';
import { startDeviceMonitor, stopDeviceMonitor } from './jobs/deviceMonitor.js';
import { startContactlessVerificationScheduler, stopContactlessVerificationScheduler } from './jobs/contactlessVerificationScheduler.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

const allowedOrigins = [
  'http://localhost:4200',
  'https://uni-backend01.web.app',
];

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no Origin header (e.g. Postman, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
connectDB();

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/hotels', hotelRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api', staffRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/catalog', serviceCatalogRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/events', eventsRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ message: '✅ StayHub Backend is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 StayHub Backend running on port ${PORT}`);
  console.log(`📍 API available at http://localhost:${PORT}/api`);
});

startDeviceMonitor();
startContactlessVerificationScheduler();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⛔ Shutting down gracefully...');
  stopDeviceMonitor();
  stopContactlessVerificationScheduler();
  await disconnectDB();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

export default app;
