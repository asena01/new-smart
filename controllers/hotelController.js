import Hotel from '../models/Hotel.js';
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceCatalogItem from '../models/ServiceCatalogItem.js';

// Default host-managed extra services every new hotel starts with, since these are
// common enough to offer out of the box. Hosts can rename, reprice, or delete them
// like any other custom service — this is just a convenience seed, not a fixed type.
const DEFAULT_CUSTOM_SERVICES = [
  {
    name: 'Conference Room Rental',
    description: 'Fully equipped conference room, billed hourly.',
    icon: '🏢',
    price: 15000,
    requiresScheduling: true
  },
  {
    name: 'Meeting Room Rental',
    description: 'Private meeting room for small groups, billed hourly.',
    icon: '💼',
    price: 8000,
    requiresScheduling: true
  }
];

// A room is available for a date range if it's not under maintenance, meets the
// guest count, and has no overlapping non-cancelled booking. Without dates, only
// the maintenance/capacity checks apply.
export async function getAvailableRooms(hotelId, rooms, checkIn, checkOut, guests) {
  let available = rooms.filter(room => room.status !== 'maintenance');

  if (guests) {
    available = available.filter(room => room.capacity >= Number(guests));
  }

  if (checkIn && checkOut) {
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const overlapping = await Booking.find({
      hotelId,
      status: { $ne: 'cancelled' },
      checkInDate: { $lt: checkOutDate },
      checkOutDate: { $gt: checkInDate }
    }).select('roomId');
    const bookedRoomNumbers = new Set(overlapping.map(b => b.roomId));
    available = available.filter(room => !bookedRoomNumbers.has(room.roomNumber));
  }

  return available;
}

export const getAllHotels = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, amenities, rating, checkIn, checkOut, guests } = req.query;

    let query = { isActive: true };

    if (city) query['location.city'] = { $regex: city, $options: 'i' };
    if (minPrice || maxPrice) {
      query['rooms.basePrice'] = {};
      if (minPrice) query['rooms.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['rooms.basePrice'].$lte = Number(maxPrice);
    }
    if (amenities) {
      const amenitiesArray = Array.isArray(amenities) ? amenities : [amenities];
      query.amenities = { $in: amenitiesArray };
    }
    if (rating) query.rating = { $gte: Number(rating) };

    const hotelDocs = await Hotel.find(query)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId')
      .populate('hostId', 'firstName lastName')
      .limit(50);

    const withAvailability = await Promise.all(
      hotelDocs.map(async hotel => {
        const plain = hotel.toObject();
        plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);
        return plain;
      })
    );

    // Only hide hotels with zero availability when the guest actually searched for dates.
    const hotels = (checkIn && checkOut) ? withAvailability.filter(h => h.rooms.length > 0) : withAvailability;

    res.status(200).json({ success: true, count: hotels.length, hotels });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getHotelById = async (req, res) => {
  try {
    const { checkIn, checkOut, guests } = req.query;

    const hotel = await Hotel.findById(req.params.id)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId')
      .populate('hostId');

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const plain = hotel.toObject();
    plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);

    res.status(200).json({ success: true, hotel: plain });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMyHotel = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });

    res.status(200).json({
      success: true,
      hotel,
      isConfigured: Boolean(hotel),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getHostDashboard = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId }).lean();

    if (!hotel) {
      return res.status(200).json({
        success: true,
        hotel: null,
        metrics: {
          rooms: 0,
          totalBookings: 0,
          activeBookings: 0,
          bookingRevenue: 0,
          serviceOrders: 0,
          serviceRevenue: 0,
        },
        serviceStats: [],
        recentBookings: [],
      });
    }

    const [bookingStats, serviceStats, recentBookings] = await Promise.all([
      Booking.aggregate([
        { $match: { hotelId: hotel._id } },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            activeBookings: {
              $sum: {
                $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0],
              },
            },
            bookingRevenue: {
              $sum: {
                $cond: [{ $ne: ['$status', 'cancelled'] }, '$totalPrice', 0],
              },
            },
          },
        },
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: hotel._id } },
        {
          $group: {
            _id: '$serviceType',
            orders: { $sum: 1 },
            pending: {
              $sum: {
                $cond: [{ $eq: ['$status', 'pending'] }, 1, 0],
              },
            },
            revenue: {
              $sum: {
                $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Booking.find({ hotelId: hotel._id })
        .populate('userId', 'firstName lastName')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

    const bookingMetrics = bookingStats[0] || {
      totalBookings: 0,
      activeBookings: 0,
      bookingRevenue: 0,
    };
    const serviceOrders = serviceStats.reduce((total, item) => total + item.orders, 0);
    const serviceRevenue = serviceStats.reduce((total, item) => total + item.revenue, 0);

    res.status(200).json({
      success: true,
      hotel,
      metrics: {
        rooms: hotel.rooms?.length || 0,
        ...bookingMetrics,
        serviceOrders,
        serviceRevenue,
      },
      serviceStats,
      recentBookings,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMyRooms = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Complete your hotel setup first' });
    }

    res.status(200).json({ success: true, hotelId: hotel._id, rooms: hotel.rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addMyRoom = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Complete your hotel setup first' });
    }

    if (hotel.rooms.some(room => room.roomNumber === req.body.roomNumber)) {
      return res.status(409).json({ message: 'That room number already exists' });
    }

    hotel.rooms.push(req.body);
    await hotel.save();
    res.status(201).json({ success: true, room: hotel.rooms.at(-1) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const updateMyRoom = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const room = hotel.rooms.id(req.params.roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const duplicate = hotel.rooms.some(
      item => item._id.toString() !== room._id.toString() &&
        item.roomNumber === req.body.roomNumber
    );
    if (duplicate) {
      return res.status(409).json({ message: 'That room number already exists' });
    }

    room.set(req.body);
    await hotel.save();
    res.status(200).json({ success: true, room });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const deleteMyRoom = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const room = hotel.rooms.id(req.params.roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    room.deleteOne();
    await hotel.save();
    res.status(200).json({ success: true, message: 'Room deleted' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const createHotel = async (req, res) => {
  try {
    const existingHotel = await Hotel.findOne({ hostId: req.user.userId });
    if (existingHotel) {
      return res.status(409).json({
        message: 'Your host account already has a hotel. Update it from Settings.',
        hotel: existingHotel,
      });
    }

    const hotelData = {
      ...req.body,
      hostId: req.user.userId,
    };

    const hotel = await Hotel.create(hotelData);

    await ServiceCatalogItem.insertMany(
      DEFAULT_CUSTOM_SERVICES.map(service => ({
        ...service,
        hotelId: hotel._id,
        serviceType: 'custom'
      }))
    );

    res.status(201).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateHotel = async (req, res) => {
  try {
    let hotel = await Hotel.findById(req.params.id);

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    if (hotel.hostId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this hotel' });
    }

    hotel = await Hotel.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteHotel = async (req, res) => {
  try {
    const hotel = await Hotel.findById(req.params.id);

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    if (hotel.hostId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this hotel' });
    }

    await Hotel.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, message: 'Hotel deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const searchHotels = async (req, res) => {
  try {
    const { city, checkIn, checkOut, guests, minPrice, maxPrice } = req.query;

    let query = { isActive: true };

    if (city) query['location.city'] = { $regex: city, $options: 'i' };
    if (minPrice || maxPrice) {
      query['rooms.basePrice'] = {};
      if (minPrice) query['rooms.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['rooms.basePrice'].$lte = Number(maxPrice);
    }

    const hotelDocs = await Hotel.find(query)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId')
      .populate('hostId', 'firstName lastName');

    const withAvailability = await Promise.all(
      hotelDocs.map(async hotel => {
        const plain = hotel.toObject();
        plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);
        return plain;
      })
    );

    const hotels = (checkIn && checkOut) ? withAvailability.filter(h => h.rooms.length > 0) : withAvailability;

    res.status(200).json({
      success: true,
      count: hotels.length,
      hotels,
      searchParams: { city, checkIn, checkOut, guests }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
