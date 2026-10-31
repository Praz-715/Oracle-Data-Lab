// Synthetic vocabulary. Names are combined at random so no row describes a real person;
// emails use reserved example.* domains and phone numbers use a fictional 555 block.

export const FIRST_NAMES = [
  'Adi', 'Agus', 'Alya', 'Andi', 'Anisa', 'Arif', 'Ayu', 'Bayu', 'Bima', 'Budi', 'Citra', 'Dani', 'Dewi', 'Dian',
  'Dimas', 'Eka', 'Elsa', 'Fajar', 'Fani', 'Farah', 'Gilang', 'Gita', 'Hadi', 'Hana', 'Hendra', 'Indah', 'Intan',
  'Irfan', 'Joko', 'Kartika', 'Kevin', 'Laras', 'Lina', 'Maya', 'Mega', 'Nadia', 'Nanda', 'Nina', 'Oki', 'Putri',
  'Raka', 'Rani', 'Reza', 'Rina', 'Rizki', 'Sari', 'Sinta', 'Surya', 'Tari', 'Teguh', 'Tika', 'Umar', 'Vina',
  'Wahyu', 'Wulan', 'Yoga', 'Yuni', 'Zahra', 'Aaron', 'Clara', 'Daniel', 'Emma', 'Felix', 'Grace', 'Hugo', 'Iris',
  'Jonas', 'Lena', 'Marco', 'Nora', 'Oscar', 'Paula', 'Ruben', 'Sofia', 'Theo', 'Vera',
] as const

export const LAST_NAMES = [
  'Pratama', 'Saputra', 'Wijaya', 'Santoso', 'Hidayat', 'Kusuma', 'Lestari', 'Nugroho', 'Purnama', 'Setiawan',
  'Siregar', 'Simanjuntak', 'Halim', 'Gunawan', 'Wibowo', 'Ramadhan', 'Permana', 'Utami', 'Rahayu', 'Hakim',
  'Sitompul', 'Tanjung', 'Harahap', 'Mahendra', 'Susanto', 'Firmansyah', 'Anggraini', 'Wulandari', 'Kurniawan',
  'Suryadi', 'Hartono', 'Sasmita', 'Nasution', 'Putra', 'Aditya', 'Maulana', 'Fauzi', 'Hutapea', 'Pane', 'Lubis',
  'Becker', 'Moreau', 'Rossi', 'Novak', 'Larsen', 'Silva', 'Keller', 'Weber', 'Costa', 'Jansen',
] as const

/** Regions with relative customer population weight and a few city names. */
export const REGIONS: { code: string; name: string; country: string; weight: number; cities: string[] }[] = [
  { code: 'ID-JK', name: 'DKI Jakarta', country: 'ID', weight: 16, cities: ['Jakarta Selatan', 'Jakarta Barat', 'Jakarta Timur', 'Jakarta Utara', 'Jakarta Pusat'] },
  { code: 'ID-JB', name: 'Jawa Barat', country: 'ID', weight: 18, cities: ['Bandung', 'Bekasi', 'Depok', 'Bogor', 'Cirebon'] },
  { code: 'ID-JT', name: 'Jawa Tengah', country: 'ID', weight: 11, cities: ['Semarang', 'Solo', 'Magelang', 'Pekalongan'] },
  { code: 'ID-JI', name: 'Jawa Timur', country: 'ID', weight: 13, cities: ['Surabaya', 'Malang', 'Sidoarjo', 'Kediri'] },
  { code: 'ID-YO', name: 'DI Yogyakarta', country: 'ID', weight: 3, cities: ['Yogyakarta', 'Sleman', 'Bantul'] },
  { code: 'ID-BT', name: 'Banten', country: 'ID', weight: 7, cities: ['Tangerang', 'Serang', 'Cilegon'] },
  { code: 'ID-BA', name: 'Bali', country: 'ID', weight: 3, cities: ['Denpasar', 'Badung', 'Gianyar'] },
  { code: 'ID-SU', name: 'Sumatera Utara', country: 'ID', weight: 5, cities: ['Medan', 'Binjai', 'Pematangsiantar'] },
  { code: 'ID-SB', name: 'Sumatera Barat', country: 'ID', weight: 2, cities: ['Padang', 'Bukittinggi'] },
  { code: 'ID-SS', name: 'Sumatera Selatan', country: 'ID', weight: 3, cities: ['Palembang', 'Prabumulih'] },
  { code: 'ID-RI', name: 'Riau', country: 'ID', weight: 2, cities: ['Pekanbaru', 'Dumai'] },
  { code: 'ID-LA', name: 'Lampung', country: 'ID', weight: 2, cities: ['Bandar Lampung', 'Metro'] },
  { code: 'ID-KB', name: 'Kalimantan Barat', country: 'ID', weight: 1.5, cities: ['Pontianak', 'Singkawang'] },
  { code: 'ID-KT', name: 'Kalimantan Timur', country: 'ID', weight: 2, cities: ['Samarinda', 'Balikpapan'] },
  { code: 'ID-KS', name: 'Kalimantan Selatan', country: 'ID', weight: 1.5, cities: ['Banjarmasin', 'Banjarbaru'] },
  { code: 'ID-SN', name: 'Sulawesi Selatan', country: 'ID', weight: 3, cities: ['Makassar', 'Parepare'] },
  { code: 'ID-SA', name: 'Sulawesi Utara', country: 'ID', weight: 1, cities: ['Manado', 'Bitung'] },
  { code: 'ID-NB', name: 'Nusa Tenggara Barat', country: 'ID', weight: 1, cities: ['Mataram'] },
  { code: 'ID-PA', name: 'Papua', country: 'ID', weight: 0.6, cities: ['Jayapura'] },
  { code: 'ID-MA', name: 'Maluku', country: 'ID', weight: 0.5, cities: ['Ambon'] },
  { code: 'SG-01', name: 'Singapore', country: 'SG', weight: 1.2, cities: ['Singapore'] },
  { code: 'MY-14', name: 'Kuala Lumpur', country: 'MY', weight: 1.2, cities: ['Kuala Lumpur'] },
]

/** Category tree: parent -> children with price median (IDR) and gross margin. */
export const CATEGORIES: { name: string; children: string[]; priceMedian: number; margin: number; weight: number }[] = [
  { name: 'Electronics', children: ['Smartphones', 'Laptops', 'Audio', 'Accessories', 'Wearables'], priceMedian: 1_800_000, margin: 0.14, weight: 14 },
  { name: 'Home & Living', children: ['Kitchen', 'Furniture', 'Decor', 'Bedding', 'Storage'], priceMedian: 280_000, margin: 0.32, weight: 12 },
  { name: 'Fashion', children: ['Men Apparel', 'Women Apparel', 'Shoes', 'Bags', 'Watches'], priceMedian: 190_000, margin: 0.45, weight: 16 },
  { name: 'Health & Beauty', children: ['Skincare', 'Makeup', 'Personal Care', 'Supplements'], priceMedian: 95_000, margin: 0.4, weight: 13 },
  { name: 'Groceries', children: ['Beverages', 'Snacks', 'Staples', 'Frozen Food'], priceMedian: 42_000, margin: 0.18, weight: 15 },
  { name: 'Sports & Outdoor', children: ['Fitness', 'Cycling', 'Camping', 'Team Sports'], priceMedian: 320_000, margin: 0.3, weight: 6 },
  { name: 'Baby & Kids', children: ['Diapers', 'Toys', 'Baby Care', 'Kids Apparel'], priceMedian: 130_000, margin: 0.28, weight: 7 },
  { name: 'Automotive', children: ['Car Care', 'Motorcycle Parts', 'Tools'], priceMedian: 210_000, margin: 0.26, weight: 4 },
  { name: 'Books & Stationery', children: ['Books', 'Office Supplies', 'Art Supplies'], priceMedian: 75_000, margin: 0.25, weight: 5 },
  { name: 'Computers & Gaming', children: ['Components', 'Peripherals', 'Consoles', 'Games'], priceMedian: 950_000, margin: 0.12, weight: 8 },
]

export const PRODUCT_ADJECTIVES = [
  'Classic', 'Pro', 'Ultra', 'Lite', 'Smart', 'Eco', 'Prime', 'Essential', 'Compact', 'Deluxe', 'Active', 'Urban',
  'Fresh', 'Premium', 'Basic', 'Max', 'Mini', 'Flex', 'Nova', 'Aero',
] as const

export const PRODUCT_NOUNS: Record<string, string[]> = {
  Smartphones: ['Phone', 'Handset'], Laptops: ['Notebook', 'Ultrabook'], Audio: ['Earbuds', 'Speaker', 'Headphones'],
  Accessories: ['Charger', 'Cable', 'Power Bank', 'Case'], Wearables: ['Smartwatch', 'Fitness Band'],
  Kitchen: ['Pan', 'Knife Set', 'Blender', 'Rice Cooker'], Furniture: ['Chair', 'Desk', 'Shelf'], Decor: ['Lamp', 'Vase', 'Frame'],
  Bedding: ['Pillow', 'Bed Sheet', 'Blanket'], Storage: ['Box', 'Rack', 'Organizer'], 'Men Apparel': ['Shirt', 'Polo', 'Chino'],
  'Women Apparel': ['Blouse', 'Dress', 'Skirt'], Shoes: ['Sneakers', 'Loafers', 'Sandals'], Bags: ['Backpack', 'Tote', 'Sling Bag'],
  Watches: ['Watch'], Skincare: ['Serum', 'Moisturizer', 'Sunscreen'], Makeup: ['Lipstick', 'Cushion', 'Mascara'],
  'Personal Care': ['Shampoo', 'Body Wash', 'Toothpaste'], Supplements: ['Vitamin C', 'Omega 3', 'Multivitamin'],
  Beverages: ['Coffee', 'Tea', 'Juice'], Snacks: ['Chips', 'Cookies', 'Nuts'], Staples: ['Rice', 'Cooking Oil', 'Sugar'],
  'Frozen Food': ['Dumplings', 'Nuggets', 'Sausage'], Fitness: ['Yoga Mat', 'Dumbbell', 'Resistance Band'],
  Cycling: ['Helmet', 'Bike Light', 'Gloves'], Camping: ['Tent', 'Sleeping Bag', 'Lantern'], 'Team Sports': ['Football', 'Jersey', 'Racket'],
  Diapers: ['Diapers'], Toys: ['Puzzle', 'Blocks', 'Doll'], 'Baby Care': ['Baby Lotion', 'Bottle', 'Wipes'],
  'Kids Apparel': ['Kids Tee', 'Kids Shorts'], 'Car Care': ['Car Shampoo', 'Wax', 'Microfiber'], 'Motorcycle Parts': ['Brake Pad', 'Chain', 'Mirror'],
  Tools: ['Wrench Set', 'Drill', 'Screwdriver'], Books: ['Novel', 'Cookbook', 'Guide'], 'Office Supplies': ['Notebook Pad', 'Pen Set', 'Stapler'],
  'Art Supplies': ['Watercolor', 'Sketchbook', 'Brush Set'], Components: ['SSD', 'RAM Kit', 'Graphics Card'],
  Peripherals: ['Keyboard', 'Mouse', 'Monitor'], Consoles: ['Console'], Games: ['Game Title', 'Controller'],
}

export const SUPPLIER_WORDS = ['Sumber', 'Makmur', 'Jaya', 'Abadi', 'Sentosa', 'Mitra', 'Global', 'Nusantara', 'Prima', 'Karya', 'Utama', 'Lestari', 'Indo', 'Cahaya', 'Bintang']
export const SUPPLIER_SUFFIX = ['Trading', 'Distribusi', 'Supply', 'Logistics', 'Industries', 'Group']

export const CARRIERS = ['JNE', 'J&T', 'SiCepat', 'AnterAja', 'Pos Indonesia', 'Ninja Xpress', 'Lion Parcel']

export const REVIEW_OPENERS = [
  'Overall the product matches the description.',
  'Delivery was quicker than expected.',
  'Packaging was neat and the item arrived safely.',
  'Quality feels solid for the price.',
  'Not exactly what I expected, but usable.',
  'Second time buying this item.',
]
export const REVIEW_DETAILS = [
  'The build quality is consistent and the finish looks good.',
  'Size and color are accurate compared to the photos.',
  'Seller responded quickly to questions about stock.',
  'Battery life and performance are within the stated specification.',
  'Instructions were clear and setup took only a few minutes.',
  'There was a minor scratch, but it does not affect usage.',
  'Would prefer more color options in the next batch.',
  'The price during the campaign was very competitive.',
]
export const REVIEW_CLOSERS = ['Recommended.', 'Will buy again.', 'Three stars for now.', 'Good value.', 'Satisfied with the purchase.']

export const RETURN_REASONS = ['DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'SIZE_ISSUE', 'CHANGED_MIND'] as const
export const PAYMENT_METHODS = ['CARD', 'BANK_TRANSFER', 'EWALLET', 'COD', 'PAYLATER'] as const
export const CHANNELS = ['WEB', 'MOBILE', 'STORE', 'MARKETPLACE'] as const
export const SEGMENTS = ['CONSUMER', 'SMB', 'CORPORATE'] as const
export const LOYALTY_TIERS = ['BASIC', 'SILVER', 'GOLD', 'PLATINUM'] as const
export const ORDER_STATUSES = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'] as const
