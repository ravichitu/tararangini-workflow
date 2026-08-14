-- ORG 1: Tarangini
INSERT OR IGNORE INTO orgs (id,display_name,registered_name,address,phone,email,gstin,gst_type,note_footer,signature_name) VALUES
(1,'TARANGINI PAPER AND BOOK BINDING WORKS','Tarangini Paper And Book Binding Works',
'First Floor, Behind Steps, Block A, Subdhra Arcade, Bhanugudi Junction, Kakinada',
'9985065665 / 8555025720','R444999@GMAIL.COM','37AVKPP7059B1ZB','composition',
'Thank you for your business!','Tarangini Paper And Book Binding Works');

-- ORG 2: Bits & Binary
INSERT OR IGNORE INTO orgs (id,display_name,registered_name,address,phone,email,gstin,gst_type,note_footer,signature_name) VALUES
(2,'BITS & BINARY','Shri Lakshmi Kalyani International',
'[Address - Please Update in Settings]','[Phone]','[Email]','[GSTIN]','regular',
'Thank you for your business!','Shri Lakshmi Kalyani International');

-- ORG 3: The Prints Men
INSERT OR IGNORE INTO orgs (id,display_name,registered_name,address,phone,email,gstin,gst_type,note_footer,signature_name) VALUES
(3,'THE PRINTS MEN','The Prints Men',
'[Address - Please Update in Settings]','[Phone]','[Email]','[GSTIN]','composition',
'Thank you for your business!','The Prints Men');

-- DEFAULT USERS (passwords: owner123, operator123 — CHANGE AFTER FIRST LOGIN)
INSERT OR IGNORE INTO users (id,name,username,password_hash,role,org_access) VALUES
(1,'Owner 1','owner1','$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGX1ZW5bQH2jYT0HGd1HGBiPyiO','owner','all'),
(2,'Owner 2','owner2','$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGX1ZW5bQH2jYT0HGd1HGBiPyiO','owner','all'),
(3,'Operator 1','operator1','$2a$12$eImiTXuWVxfM37uY9mDIgeUE5B1WXpUGAQRPlZqpqFhWuFMFuFpqy','operator','[1]'),
(4,'Operator 2','operator2','$2a$12$eImiTXuWVxfM37uY9mDIgeUE5B1WXpUGAQRPlZqpqFhWuFMFuFpqy','operator','[2]');

INSERT OR IGNORE INTO system_settings (key,value) VALUES
('auto_lock_enabled','1'),
('auto_lock_minutes','15'),
('auto_lock_warning_seconds','60'),
('automatic_backup_enabled','1'),
('automatic_backup_hours','24'),
('automatic_backup_directory','');

-- ITEM CATEGORIES ORG 1
INSERT OR IGNORE INTO item_categories (id,org_id,name,hsn_code) VALUES
(1,1,'Stationery','9608'),(2,1,'Paper & Notebooks','4820'),(3,1,'Book Binding','4819'),
(4,1,'Printing Services','9989'),(5,1,'Digital / UV Printing','9989'),(6,1,'Arts & Crafts','3213');

-- ITEM CATEGORIES ORG 2
INSERT OR IGNORE INTO item_categories (id,org_id,name,hsn_code) VALUES
(7,2,'Laptops','8471'),(8,2,'Desktops','8471'),(9,2,'Computer Parts','8473'),
(10,2,'Speakers & Audio','8518'),(11,2,'Repair Services','9987'),(12,2,'Cables & Accessories','8544');

-- ITEM CATEGORIES ORG 3
INSERT OR IGNORE INTO item_categories (id,org_id,name,hsn_code) VALUES
(13,3,'Photo Printing','9989'),(14,3,'Photo Frames','4414'),(15,3,'Customized Gifts','3926'),(16,3,'Canvas Prints','9989');

-- SAMPLE ITEMS ORG 1
INSERT OR IGNORE INTO items (id,org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price) VALUES
(1,1,1,'Ball Pen (Blue)','9608','NOS',12,5),
(2,1,1,'Pencil HB','9608','NOS',12,3),
(3,1,1,'Stapler','9608','NOS',12,80),
(4,1,1,'Stapler Pins Box','9608','BOX',12,25),
(5,1,1,'Scissors','9608','NOS',12,30),
(6,1,2,'A4 Paper Ream (500 Sheets)','4802','PKT',12,200),
(7,1,2,'A3 Paper Ream','4802','PKT',12,350),
(8,1,2,'Notebook (200 Pages)','4820','NOS',12,45),
(9,1,2,'Register (500 Pages)','4820','NOS',12,90),
(10,1,3,'Spiral Binding (per book)','4819','NOS',5,20),
(11,1,3,'Hard Bind (per book)','4819','NOS',5,80),
(12,1,3,'Binding Wire Roll','4819','NOS',5,150),
(13,1,3,'Lamination (A4)','4819','NOS',5,10),
(14,1,4,'Photocopy (per page)','9989','NOS',5,1),
(15,1,4,'Color Print (A4)','9989','NOS',5,5),
(16,1,4,'Black & White Print (A4)','9989','NOS',5,1),
(17,1,5,'Digital Print (A4)','9989','NOS',5,15),
(18,1,5,'UV Print (A4)','9989','NOS',5,25),
(19,1,6,'Sketch Pens (Set 12)','3213','SET',12,60),
(20,1,6,'Watercolor Box','3213','BOX',12,120);

-- SAMPLE ITEMS ORG 2
INSERT OR IGNORE INTO items (id,org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price) VALUES
(21,2,7,'Laptop 15inch (Basic)','8471','NOS',18,25000),
(22,2,7,'Laptop 15inch (Core i5)','8471','NOS',18,40000),
(23,2,8,'Desktop Computer (Basic)','8471','NOS',18,18000),
(24,2,8,'Desktop Computer (Gaming)','8471','NOS',18,45000),
(25,2,9,'RAM 8GB DDR4','8473','NOS',18,1200),
(26,2,9,'SSD 256GB','8473','NOS',18,2000),
(27,2,9,'Hard Disk 1TB','8473','NOS',18,2500),
(28,2,9,'Motherboard (B450)','8473','NOS',18,6000),
(29,2,10,'Speaker 2.1 Channel','8518','NOS',18,800),
(30,2,10,'Headphones','8518','NOS',18,500),
(31,2,11,'Computer Repair (Labour)','9987','NOS',18,200),
(32,2,11,'Laptop Screen Replacement','9987','NOS',18,2500),
(33,2,12,'HDMI Cable 1.5m','8544','NOS',18,150),
(34,2,12,'USB Hub 4 Port','8544','NOS',18,250);

-- SAMPLE ITEMS ORG 3
INSERT OR IGNORE INTO items (id,org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price) VALUES
(35,3,13,'Photo Print 4x6','9989','NOS',5,10),
(36,3,13,'Photo Print 5x7','9989','NOS',5,20),
(37,3,13,'Photo Print 8x10','9989','NOS',5,50),
(38,3,14,'Photo Frame 4x6','4414','NOS',12,80),
(39,3,14,'Photo Frame 8x10','4414','NOS',12,150),
(40,3,15,'Customized Mug','3926','NOS',12,200),
(41,3,15,'Customized T-Shirt','3926','NOS',5,350),
(42,3,15,'Customized Keychain','3926','NOS',12,80),
(43,3,16,'Canvas Print 12x18','9989','NOS',5,300),
(44,3,16,'Canvas Print 18x24','9989','NOS',5,500);
