# StayHub Backend API

A production-ready Node.js/Express backend for the StayHub hotel booking platform with MongoDB integration, JWT authentication, and smart lock integration.

## Features

- **User Management**: Registration, login, profile management
- **Hotel Management**: Create, read, update, delete hotels
- **Booking System**: Complete booking flow with payment integration
- **Contactless Check-in**: TTLock smart lock integration for secure, contactless check-in
- **Identity Verification**: Didit integration for KYC/AML compliance
- **Email Notifications**: Booking confirmations and notifications
- **JWT Authentication**: Secure token-based authentication
- **Role-Based Access**: Guest, Host, and Admin roles

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose
- **Authentication**: JWT (jsonwebtoken)
- **Security**: bcryptjs for password hashing
- **Email**: Nodemailer
- **External APIs**: TTLock, Didit, Stripe/PayPal

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file (use `.env.example` as template):
```bash
cp .env.example .env
```

3. Update `.env` with your credentials:
   - MongoDB URI
   - JWT Secret
   - Email credentials
   - TTLock credentials
   - Didit credentials

## Running the Server

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/profile` - Get user profile (protected)
- `PUT /api/auth/profile` - Update user profile (protected)

### Hotels
- `GET /api/hotels` - Get all hotels
- `GET /api/hotels/search?city=&checkIn=&checkOut=` - Search hotels
- `GET /api/hotels/:id` - Get hotel details
- `POST /api/hotels` - Create hotel (host/admin)
- `PUT /api/hotels/:id` - Update hotel (host/admin)
- `DELETE /api/hotels/:id` - Delete hotel (host/admin)

### Bookings
- `POST /api/bookings` - Create booking (protected)
- `GET /api/bookings` - Get user bookings (protected)
- `GET /api/bookings/:id` - Get booking details (protected)
- `PUT /api/bookings/:id/cancel` - Cancel booking (protected)
- `POST /api/bookings/:id/contactless-checkin` - Setup contactless check-in (protected)
- `PUT /api/bookings/:id/confirm-checkin` - Confirm check-in (protected)

### Health
- `GET /api/health` - Health check

## Database Models

### User
- firstName, lastName, email, password
- phone, profileImage
- isVerified, identityVerificationStatus
- role (guest, host, admin)

### Hotel
- name, description, location
- hostId (reference to User)
- images, amenities, rating
- rooms (with basePrice and capacity)
- smartLockIntegration (TTLock/Tuya config)
- policies (checkInTime, checkOutTime, cancellation)

### Booking
- userId, hotelId, roomId
- checkInDate, checkOutDate, numberOfGuests
- totalPrice, paymentStatus
- contactlessCheckIn config
- bookingReference (unique)

### Review
- hotelId, userId, bookingId
- rating, title, comment
- specific ratings (cleanliness, comfort, amenities, staff, value)

## Integration Guides

### TTLock Smart Lock
The backend integrates with TTLock for contactless check-in:

1. Configure `TTLOCK_CLIENT_ID` and `TTLOCK_CLIENT_SECRET` in `.env`
2. Add TTLock device ID to hotel's `smartLockIntegration`
3. When booking is confirmed, call `POST /api/bookings/:id/contactless-checkin`
4. Guest receives access code valid from check-in to check-out time

### Didit Identity Verification
For KYC/AML compliance:

1. Set up `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` in `.env`
2. User initiates verification through frontend
3. Backend generates workflow session
4. After verification, user status updates to verified

### Email Notifications
- Booking confirmations sent automatically
- Uses Gmail SMTP with app password
- Configure `EMAIL_USER` and `GMAIL_APP_PASSWORD`

## Error Handling

All endpoints return JSON responses:

Success (200-201):
```json
{
  "success": true,
  "data": {}
}
```

Error (4xx-5xx):
```json
{
  "message": "Error description"
}
```

## Security Considerations

- All passwords are hashed with bcryptjs
- JWT tokens expire after 7 days
- Protected routes require valid Bearer token
- Role-based authorization for sensitive operations
- CORS enabled for frontend URL only
- Environment variables for sensitive data

## Contributing

Follow these guidelines:
- Use consistent naming conventions
- Add error handling to all routes
- Test with Postman/Thunder Client
- Update this README for new features

## License

MIT
