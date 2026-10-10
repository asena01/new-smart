import ServiceCatalogItem from '../models/ServiceCatalogItem.js';
import Hotel from '../models/Hotel.js';
import ServiceOrder from '../models/ServiceOrder.js';

// A ServiceOrder that hasn't reached one of these states can still change/be acted on — an
// order in any of them is done for good (see updateServiceOrderStatus, which never lets a
// terminal status transition back out), so only non-terminal orders are worth checking.
const TERMINAL_ORDER_STATUSES = ['completed', 'cancelled', 'delivered'];

// restaurant/bar orders store a real itemId per line; laundry/transportation orders were never
// given an id field and are matched by name instead, the same loose way
// computeAuthoritativePricing itself re-resolves them at order-creation time — so a catalog
// item renamed after a pending laundry/transportation order was placed could go undetected
// here, same as it already would at creation time. early-checkin/late-checkout intentionally
// have no entry: those two service types price entirely off Hotel.policies and never
// reference ServiceCatalogItem at all (see computeAuthoritativePricing), so no pending order
// of those types could ever be broken by deleting a catalog "item" for them.
async function findActiveOrdersReferencingItem(item) {
  const activeOrders = await ServiceOrder.find({
    hotelId: item.hotelId._id || item.hotelId,
    serviceType: item.serviceType,
    status: { $nin: TERMINAL_ORDER_STATUSES }
  });

  if (item.serviceType === 'restaurant' || item.serviceType === 'bar') {
    return activeOrders.filter(order =>
      (order.serviceDetails?.items || []).some(i => String(i.itemId) === String(item._id))
    );
  }
  if (item.serviceType === 'laundry') {
    return activeOrders.filter(order =>
      (order.serviceDetails?.laundryItems || []).some(li => li.itemType === item.name) ||
      order.serviceDetails?.serviceLevel === item.name
    );
  }
  if (item.serviceType === 'transportation') {
    return activeOrders.filter(order => order.serviceDetails?.serviceOption === item.name);
  }
  return [];
}

// Same rule the schema itself enforces (see models/ServiceCatalogItem.js) — checked here too
// so a bad payload gets a clear, specific 400 up front instead of only surfacing through
// whatever a Mongoose ValidationError happens to say.
function validateCatalogPricing(price, discountPrice) {
  if (price != null && Number(price) < 0) {
    return 'Price cannot be negative.';
  }
  if (discountPrice != null && discountPrice !== '' && Number(discountPrice) < 0) {
    return 'Discount price cannot be negative.';
  }
  if (discountPrice != null && discountPrice !== '' && Number(discountPrice) !== 0 && Number(discountPrice) >= Number(price)) {
    return 'Discount price must be lower than the price.';
  }
  return null;
}

// Host: add a catalog item (menu item, laundry price, transport option, etc.)
export const createItem = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { serviceType, name, description, category, icon, price, discountPrice, currency, images, prepTime, capacity, perPassengerFee, perLuggageFee, vehicleCapacity, requiresScheduling, isAvailable, sortOrder } = req.body;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    if (!serviceType || !name || price === undefined) {
      return res.status(400).json({ error: 'serviceType, name, and price are required' });
    }

    const priceError = validateCatalogPricing(price, discountPrice);
    if (priceError) {
      return res.status(400).json({ error: priceError });
    }

    const item = await ServiceCatalogItem.create({
      hotelId,
      serviceType,
      name,
      description,
      category,
      icon,
      price,
      discountPrice,
      currency,
      images,
      prepTime,
      capacity,
      perPassengerFee,
      perLuggageFee,
      vehicleCapacity,
      requiresScheduling,
      isAvailable,
      sortOrder
    });

    res.status(201).json({ message: 'Item added successfully', item });
  } catch (error) {
    console.error('Error creating catalog item:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create catalog item' });
  }
};

// Any authenticated user (host managing it, or a guest browsing a hotel's services) can read the catalog
export const getHotelCatalog = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { serviceType, availableOnly } = req.query;

    const filter = { hotelId };
    if (serviceType) filter.serviceType = serviceType;
    if (availableOnly === 'true') filter.isAvailable = true;

    const items = await ServiceCatalogItem.find(filter).sort({ serviceType: 1, sortOrder: 1, name: 1 });

    res.json({ items });
  } catch (error) {
    console.error('Error fetching hotel catalog:', error);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
};

// Host: edit a catalog item
export const updateItem = async (req, res) => {
  try {
    const { itemId } = req.params;

    const item = await ServiceCatalogItem.findById(itemId).populate('hotelId');
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.hotelId.hostId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to edit this item' });
    }

    const updates = { ...req.body };
    delete updates.hotelId;
    delete updates.serviceType;

    // A partial update might only touch one of the two price fields — validate against the
    // combination that will actually be in effect afterward, not just whatever's in this body.
    const effectivePrice = 'price' in updates ? updates.price : item.price;
    const effectiveDiscountPrice = 'discountPrice' in updates ? updates.discountPrice : item.discountPrice;
    const priceError = validateCatalogPricing(effectivePrice, effectiveDiscountPrice);
    if (priceError) {
      return res.status(400).json({ error: priceError });
    }

    Object.assign(item, updates);
    await item.save();

    res.json({ message: 'Item updated successfully', item });
  } catch (error) {
    console.error('Error updating catalog item:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update catalog item' });
  }
};

// Host: remove a catalog item
export const deleteItem = async (req, res) => {
  try {
    const { itemId } = req.params;

    const item = await ServiceCatalogItem.findById(itemId).populate('hotelId');
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.hotelId.hostId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to delete this item' });
    }

    const referencingOrders = await findActiveOrdersReferencingItem(item);
    if (referencingOrders.length) {
      return res.status(409).json({
        error: `"${item.name}" cannot be deleted — it's referenced by ${referencingOrders.length} order${referencingOrders.length > 1 ? 's' : ''} still in progress. Mark it unavailable instead, or wait until those orders are completed or cancelled.`
      });
    }

    await ServiceCatalogItem.findByIdAndDelete(itemId);

    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting catalog item:', error);
    res.status(500).json({ error: 'Failed to delete catalog item' });
  }
};
