import ServiceCatalogItem from '../models/ServiceCatalogItem.js';
import Hotel from '../models/Hotel.js';

// Host: add a catalog item (menu item, laundry price, transport option, etc.)
export const createItem = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { serviceType, name, description, category, icon, price, discountPrice, currency, images, prepTime, capacity, perPassengerFee, perLuggageFee } = req.body;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    if (!serviceType || !name || price === undefined) {
      return res.status(400).json({ error: 'serviceType, name, and price are required' });
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
      perLuggageFee
    });

    res.status(201).json({ message: 'Item added successfully', item });
  } catch (error) {
    console.error('Error creating catalog item:', error);
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

    Object.assign(item, updates);
    await item.save();

    res.json({ message: 'Item updated successfully', item });
  } catch (error) {
    console.error('Error updating catalog item:', error);
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

    await ServiceCatalogItem.findByIdAndDelete(itemId);

    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting catalog item:', error);
    res.status(500).json({ error: 'Failed to delete catalog item' });
  }
};
