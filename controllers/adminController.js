import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import SmartLockDevice from '../models/SmartLockDevice.js';
import PlatformSettings from '../models/PlatformSettings.js';

const PERIOD_DAYS = 30;
const VALID_ROLES = ['guest', 'host', 'admin', 'staff'];

async function getOrCreateSettings() {
  const existing = await PlatformSettings.findOne({});
  if (existing) return existing;
  return PlatformSettings.create({});
}

const SERVICE_LABELS = {
  'restaurant': 'Restaurant',
  'bar': 'Bar & Beverages',
  'laundry': 'Laundry',
  'transportation': 'Transportation',
  'early-checkin': 'Early Check-in',
  'room-upgrade': 'Room Upgrade'
};

const LOCK_LABELS = {
  'ttlock': 'TTLock',
  'tuya': 'Tuya'
};

function hotelLocationLabel(hotel) {
  return hotel.location ? `${hotel.location.city}, ${hotel.location.country}` : '';
}

// Platform-wide overview: hotel roster, booking/device totals, smart-lock assignments
export const getDashboard = async (req, res) => {
  try {
    const hotels = await Hotel.find({})
      .populate('hostId', 'firstName lastName')
      .lean();

    // Scope every booking/service-order aggregation to hotels that still exist —
    // the DB has orphaned bookings/orders left over from deleted legacy hotels,
    // and those must not be counted in platform totals.
    const hotelIds = hotels.map(h => h._id);

    const devices = await SmartLockDevice.find({}).populate('hotelId', 'name').lean();
    const ttlock = devices.filter(d => d.provider === 'ttlock').length;
    const tuya = devices.filter(d => d.provider === 'tuya').length;

    const primaryLockByHotel = {};
    for (const device of devices) {
      if (device.hotelId && !primaryLockByHotel[String(device.hotelId._id)]) {
        primaryLockByHotel[String(device.hotelId._id)] = device.provider;
      }
    }

    const [bookingAgg, serviceAgg] = await Promise.all([
      Booking.aggregate([
        { $match: { hotelId: { $in: hotelIds } } },
        {
          $group: {
            _id: null,
            activeBookings: { $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0] } },
            bookingRevenue: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, '$totalPrice', 0] } }
          }
        }
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: { $in: hotelIds } } },
        {
          $group: {
            _id: null,
            serviceRevenue: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0] } }
          }
        }
      ])
    ]);

    const bookingStats = bookingAgg[0] || { activeBookings: 0, bookingRevenue: 0 };
    const serviceRevenue = serviceAgg[0]?.serviceRevenue || 0;
    const platformRevenue = bookingStats.bookingRevenue + serviceRevenue;

    const hotelList = hotels.map(hotel => {
      const primaryLock = primaryLockByHotel[String(hotel._id)] || null;
      return {
        _id: hotel._id,
        name: hotel.name,
        owner: hotel.hostId ? `${hotel.hostId.firstName} ${hotel.hostId.lastName}` : 'Unknown',
        location: hotelLocationLabel(hotel),
        rooms: (hotel.rooms || []).length,
        smartLock: primaryLock ? LOCK_LABELS[primaryLock] : null,
        status: hotel.isActive ? 'active' : 'inactive'
      };
    });

    const assignments = devices
      .filter(d => d.hotelId)
      .map(d => ({
        hotelName: d.hotelId.name,
        roomNumber: d.roomNumber,
        deviceName: d.deviceName,
        deviceType: LOCK_LABELS[d.provider] || d.provider,
        assignedDate: d.createdAt,
        status: d.connectionStatus === 'error' ? 'inactive' : 'active'
      }));

    res.json({
      totals: {
        totalHotels: hotels.length,
        activeBookings: bookingStats.activeBookings,
        ttlockDevices: ttlock,
        tuyaDevices: tuya,
        platformRevenue
      },
      hotels: hotelList,
      assignments
    });
  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({ message: 'Failed to fetch admin dashboard' });
  }
};

// Platform-wide analytics: revenue/commission, per-service performance, hotel leaderboard, growth trends
export const getAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const periodStart = new Date(now.getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const prevPeriodStart = new Date(now.getTime() - 2 * PERIOD_DAYS * 24 * 60 * 60 * 1000);

    const hotels = await Hotel.find({}).select('name location rating reviewCount isActive createdAt').lean();
    const activeHotels = hotels.filter(h => h.isActive).length;

    // Scope every aggregation to hotels that still exist — see note in getDashboard.
    const hotelIds = hotels.map(h => h._id);

    const settings = await getOrCreateSettings();

    const [
      bookingTotal,
      serviceTotal,
      serviceByType,
      serviceByTypePrev,
      bookingsByHotel,
      servicesByHotel,
      newGuestsCount,
      newHotelsCount,
      ordersLast30,
      ordersPrev30,
      totalGuestsCount
    ] = await Promise.all([
      Booking.aggregate([
        { $match: { hotelId: { $in: hotelIds }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, revenue: { $sum: '$totalPrice' }, count: { $sum: 1 } } }
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: { $in: hotelIds } } },
        { $group: { _id: null, revenue: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0] } } } }
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: { $in: hotelIds }, createdAt: { $gte: periodStart } } },
        { $group: {
            _id: '$serviceType',
            totalRevenue: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0] } },
            totalOrders: { $sum: 1 }
        } }
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: { $in: hotelIds }, createdAt: { $gte: prevPeriodStart, $lt: periodStart } } },
        { $group: {
            _id: '$serviceType',
            totalRevenue: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0] } }
        } }
      ]),
      Booking.aggregate([
        { $match: { hotelId: { $in: hotelIds }, status: { $ne: 'cancelled' } } },
        { $group: { _id: '$hotelId', revenue: { $sum: '$totalPrice' }, orders: { $sum: 1 } } }
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: { $in: hotelIds }, status: { $ne: 'cancelled' } } },
        { $group: { _id: '$hotelId', revenue: { $sum: '$total' }, orders: { $sum: 1 } } }
      ]),
      User.countDocuments({ role: 'guest', createdAt: { $gte: periodStart } }),
      Hotel.countDocuments({ createdAt: { $gte: periodStart } }),
      ServiceOrder.countDocuments({ hotelId: { $in: hotelIds }, createdAt: { $gte: periodStart } }),
      ServiceOrder.countDocuments({ hotelId: { $in: hotelIds }, createdAt: { $gte: prevPeriodStart, $lt: periodStart } }),
      User.countDocuments({ role: 'guest' })
    ]);

    const totalBookingRevenue = bookingTotal[0]?.revenue || 0;
    const totalBookingCount = bookingTotal[0]?.count || 0;
    const totalServiceRevenue = serviceTotal[0]?.revenue || 0;
    const platformRevenue = totalBookingRevenue + totalServiceRevenue;
    const platformCommission = Math.round(platformRevenue * settings.commissionRate * 100) / 100;

    const prevRevenueByType = Object.fromEntries(serviceByTypePrev.map(s => [s._id, s.totalRevenue]));
    const serviceMetrics = serviceByType
      .map(s => {
        const prevRevenue = prevRevenueByType[s._id] || 0;
        const growth = prevRevenue > 0
          ? Math.round(((s.totalRevenue - prevRevenue) / prevRevenue) * 100)
          : (s.totalRevenue > 0 ? 100 : 0);
        return {
          service: SERVICE_LABELS[s._id] || s._id,
          totalRevenue: s.totalRevenue,
          totalOrders: s.totalOrders,
          avgOrderValue: s.totalOrders ? Math.round((s.totalRevenue / s.totalOrders) * 100) / 100 : 0,
          growth
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const bookingByHotel = Object.fromEntries(bookingsByHotel.map(b => [String(b._id), b]));
    const serviceByHotel = Object.fromEntries(servicesByHotel.map(s => [String(s._id), s]));

    const hotelMetrics = hotels
      .map(hotel => {
        const id = String(hotel._id);
        const b = bookingByHotel[id] || { revenue: 0, orders: 0 };
        const s = serviceByHotel[id] || { revenue: 0, orders: 0 };
        return {
          id,
          name: hotel.name,
          location: hotelLocationLabel(hotel),
          revenue: b.revenue + s.revenue,
          orders: b.orders + s.orders,
          rating: hotel.rating || 0,
          status: hotel.isActive ? 'Active' : 'Inactive'
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const ordersGrowthPercent = ordersPrev30 > 0
      ? Math.round(((ordersLast30 - ordersPrev30) / ordersPrev30) * 100)
      : (ordersLast30 > 0 ? 100 : 0);

    res.json({
      platformMetrics: {
        totalRevenue: platformRevenue,
        activeHotels,
        totalBookings: totalBookingCount,
        platformCommission,
        totalGuests: totalGuestsCount
      },
      serviceMetrics,
      hotelMetrics,
      growthTrends: {
        newHotels: newHotelsCount,
        newGuests: newGuestsCount,
        ordersGrowthPercent
      }
    });
  } catch (error) {
    console.error('Error fetching admin analytics:', error);
    res.status(500).json({ message: 'Failed to fetch admin analytics' });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

// Lightweight hotel list for admin pickers — just enough to resolve a hotel's owner
export const getHotelsList = async (req, res) => {
  try {
    const hotels = await Hotel.find({}).select('_id name hostId').sort({ name: 1 });
    res.json({ hotels });
  } catch (error) {
    console.error('Error fetching hotels list:', error);
    res.status(500).json({ message: 'Failed to fetch hotels list' });
  }
};

export const updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ message: 'Failed to update user role' });
  }
};

export const createUser = async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body;
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: 'First name, last name, email, and password are required' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ message: 'A user with this email already exists' });
    }

    const user = await User.create({ firstName, lastName, email, password, phone, role: role || 'guest' });
    const userResponse = user.toObject();
    delete userResponse.password;
    res.status(201).json({ user: userResponse });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: error.message || 'Failed to create user' });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, role, password } = req.body;
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const user = await User.findById(req.params.id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (email && email.toLowerCase() !== user.email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(400).json({ message: 'A user with this email already exists' });
      }
      user.email = email;
    }

    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (phone !== undefined) user.phone = phone;
    if (role) user.role = role;
    if (password) user.password = password;

    await user.save();
    const userResponse = user.toObject();
    delete userResponse.password;
    res.status(200).json({ user: userResponse });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: error.message || 'Failed to update user' });
  }
};

export const deleteUser = async (req, res) => {
  try {
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ message: "You can't delete your own account" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'host') {
      const ownedHotel = await Hotel.findOne({ hostId: user._id });
      if (ownedHotel) {
        return res.status(400).json({ message: `This host still owns "${ownedHotel.name}" — reassign or remove the hotel before deleting the account` });
      }
    }

    await user.deleteOne();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: error.message || 'Failed to delete user' });
  }
};

export const updateHotelStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive must be a boolean' });
    }

    const hotel = await Hotel.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    res.json({ hotel });
  } catch (error) {
    console.error('Error updating hotel status:', error);
    res.status(500).json({ message: 'Failed to update hotel status' });
  }
};

export const getSettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json({ settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ message: 'Failed to fetch settings' });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { commissionRate } = req.body;
    if (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 1) {
      return res.status(400).json({ message: 'commissionRate must be a number between 0 and 1' });
    }

    const settings = await getOrCreateSettings();
    settings.commissionRate = commissionRate;
    settings.updatedAt = new Date();
    await settings.save();

    res.json({ settings });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ message: 'Failed to update settings' });
  }
};
