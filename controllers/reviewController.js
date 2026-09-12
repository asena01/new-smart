import mongoose from 'mongoose';
import Review from '../models/Review.js';
import { sendToHotel } from '../utils/sseHub.js';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import { createNotification } from '../utils/notificationUtils.js';

// Denormalized onto Hotel so hotel lists/search can sort/filter by rating without an
// aggregation join on every request — recomputed from the Review collection any time
// a review is added, kept as the source of truth for individual review documents.
async function recomputeHotelRating(hotelId) {
  const stats = await Review.aggregate([
    // aggregate() bypasses Mongoose's schema-based auto-casting, unlike find(), so a
    // string hotelId here would silently match nothing — it must be cast explicitly.
    { $match: { hotelId: new mongoose.Types.ObjectId(hotelId) } },
    { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
  ]);
  const { avgRating = 0, count = 0 } = stats[0] || {};
  await Hotel.findByIdAndUpdate(hotelId, {
    rating: Math.round(avgRating * 10) / 10,
    reviewCount: count
  });
}

// Same rule guest-bookings.ts uses to decide whether to even show the "Write a Review" link
// (stayCompleted) — defined once here and reused, so eligibility can never silently diverge
// between what the guest sees offered and what the backend actually accepts.
function isBookingReviewEligible(booking) {
  return booking.status === 'completed' || !!booking.checkOutInfo?.actualCheckOutTime;
}

// Create a review — tied to the specific completed booking the guest wrote it from (not just
// "some" completed stay at this hotel — a guest with more than one past stay must review the
// one they actually clicked from, and the resulting review must be traceable to it), and only
// ever once per hotel (see the unique index on the Review model; the existing-review lookup
// below just gives a friendlier error than a raw duplicate-key failure).
export const createReview = async (req, res) => {
  try {
    const { hotelId, bookingId, rating, title, comment, cleanliness, comfort, amenities, staff, value } = req.body;
    const userId = req.user.userId;

    if (!hotelId || !bookingId || !rating) {
      return res.status(400).json({ error: 'hotelId, bookingId, and rating are required' });
    }

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Never trust a client-supplied bookingId at face value — it must actually belong to this
    // guest and this hotel, otherwise a guest could pass any booking id (e.g. someone else's,
    // or one at a different hotel) and have a review misattributed to it.
    const booking = await Booking.findOne({ _id: bookingId, hotelId, userId });
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found for this guest and hotel.' });
    }

    if (!isBookingReviewEligible(booking)) {
      return res.status(403).json({ error: 'You can only review a hotel after completing a stay there.' });
    }

    const existing = await Review.findOne({ hotelId, userId });
    if (existing) {
      return res.status(409).json({ error: "You've already reviewed this hotel." });
    }

    let review;
    try {
    review = await Review.create({
        hotelId,
        userId,
        bookingId: booking._id,
        rating,
        title,
        comment,
        cleanliness,
        comfort,
        amenities,
        staff,
        value
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "You've already reviewed this hotel." });
      }
      throw err;
    }

    await recomputeHotelRating(hotelId);

    await createNotification({
      userId: hotel.hostId,
      type: 'alert',
      title: 'New Review',
      message: `Your hotel received a new ${rating}-star review.`,
      link: '/host/reviews',
      actionLabel: 'View Review'
    });
    sendToHotel(hotelId, 'review-created', { reviewId: review._id, rating: review.rating });

    res.status(201).json({ message: 'Review submitted', review });
  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({ error: 'Failed to submit review' });
  }
};

// Public — anyone browsing a hotel can see its reviews before booking
export const getHotelReviews = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const reviews = await Review.find({ hotelId })
      .populate('userId', 'firstName lastName')
      .sort({ createdAt: -1 });

    res.json({ reviews });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
};

// Lets the guest-facing UI know upfront whether to show "Write a Review" or the
// already-submitted state, instead of guessing from a failed submit.
export const getMyReviewForHotel = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const review = await Review.findOne({ hotelId, userId: req.user.userId });
    res.json({ review: review || null });
  } catch (error) {
    console.error('Error fetching your review:', error);
    res.status(500).json({ error: 'Failed to fetch review' });
  }
};

// Host responds to a review on their own hotel — one reply per review, overwritable
// (re-submitting just edits the existing reply rather than creating a thread).
export const respondToReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Reply text is required' });
    }

    const review = await Review.findById(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    const hotel = await Hotel.findOne({ _id: review.hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(403).json({ error: 'Not authorized to respond to this review' });
    }

    review.hostReply = { text: text.trim(), respondedAt: new Date() };
    await review.save();
    sendToHotel(review.hotelId, 'review-replied', { reviewId: review._id });
    await review.populate('userId', 'firstName lastName');

    await createNotification({
      userId: review.userId,
      type: 'alert',
      title: `${hotel.name} replied to your review`,
      message: text.trim().slice(0, 80),
      link: `/hotel/${hotel._id}`,
      actionLabel: 'View Reply'
    });

    res.json({ message: 'Reply posted', review });
  } catch (error) {
    console.error('Error responding to review:', error);
    res.status(500).json({ error: 'Failed to post reply' });
  }
};

const REVIEW_SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  // Tied ratings break by newest first, matching the frontend's own tie-break rule (see
  // sortReviews in reviewsSummary.ts) so switching between client and server sort orders
  // (before/after this endpoint was paginated) never reordered a tied pair differently.
  highest: { rating: -1, createdAt: -1 },
  lowest: { rating: 1, createdAt: -1 }
};

const REVIEWS_MAX_PAGE_SIZE = 50;

// Host's own reviews inbox. Paginated server-side (rather than shipping the hotel's entire
// review history on every load) — a popular hotel can accumulate thousands of reviews, and
// the old unbounded find() both sent that whole payload over the wire and rendered it all in
// one unpaginated list client-side. The rating summary (average/breakdown/unanswered count)
// still reflects every review regardless of the current page or unanswered filter, so it
// stays computed separately via the denormalized Hotel.rating/reviewCount fields (kept in
// sync by recomputeHotelRating above) plus one small aggregate for the star breakdown and
// unanswered count, instead of requiring the full review list on the client to compute.
export const getMyHotelReviews = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(REVIEWS_MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const sortSpec = REVIEW_SORT_OPTIONS[req.query.sort] || REVIEW_SORT_OPTIONS.newest;

    const filter = { hotelId: hotel._id };
    if (req.query.unanswered === 'true') {
      filter.$or = [{ 'hostReply.text': { $exists: false } }, { 'hostReply.text': '' }];
    }
    const minRating = parseInt(req.query.minRating, 10);
    if (minRating >= 1 && minRating <= 5) filter.rating = { $gte: minRating };
    if (typeof req.query.keyword === 'string' && req.query.keyword.trim()) {
      const keyword = req.query.keyword.trim().slice(0, 100);
      filter.$and = [{ $or: [{ title: { $regex: keyword, $options: 'i' } }, { comment: { $regex: keyword, $options: 'i' } }] }];
    }
    if (req.query.dateFrom || req.query.dateTo) {
      const createdAt = {};
      if (req.query.dateFrom) createdAt.$gte = new Date(`${req.query.dateFrom}T00:00:00.000Z`);
      if (req.query.dateTo) createdAt.$lt = new Date(`${req.query.dateTo}T00:00:00.000Z`);
      if (createdAt.$gte && createdAt.$lt && createdAt.$gte >= createdAt.$lt) return res.status(400).json({ error: 'Invalid review date range' });
      filter.createdAt = createdAt;
    }

    const [reviews, total, breakdownAgg] = await Promise.all([
      Review.find(filter)
        .populate('userId', 'firstName lastName')
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Review.countDocuments(filter),
      Review.aggregate([
        { $match: { hotelId: hotel._id } },
        {
          $group: {
            _id: null,
            star5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
            star4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
            star3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
            star2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
            star1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
            unanswered: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$hostReply.text', ''] }, ''] }, 1, 0] } }
          }
        }
      ])
    ]);

    const buckets = breakdownAgg[0] || {};
    const totalReviews = hotel.reviewCount || 0;

    res.json({
      reviews,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        averageRating: hotel.rating || 0,
        totalReviews,
        unansweredCount: buckets.unanswered || 0,
        ratingBreakdown: [5, 4, 3, 2, 1].map(star => {
          const count = buckets[`star${star}`] || 0;
          return { star, count, percent: totalReviews ? (count / totalReviews) * 100 : 0 };
        })
      }
    });
  } catch (error) {
    console.error('Error fetching hotel reviews:', error);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
};
