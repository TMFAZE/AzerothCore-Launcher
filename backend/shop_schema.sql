-- Shop Database Schema for WoW Launcher
-- Creates a separate shop database with tables for managing virtual shop items

CREATE DATABASE IF NOT EXISTS `shop` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
USE `shop`;

-- Shop categories (mounts, services, gear sets, etc.)
CREATE TABLE `shop_categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text,
  `icon` varchar(255) DEFAULT NULL,
  `sort_order` int(11) DEFAULT 0,
  `active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Shop items (individual items for sale)
CREATE TABLE `shop_items` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `category_id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `icon` varchar(255) DEFAULT NULL,
  `price_gold` bigint(20) NOT NULL DEFAULT 0,
  `item_type` enum('mount','service','gear_set','item','consumable') NOT NULL,
  `item_data` json DEFAULT NULL, -- Stores specific item IDs, quantities, etc.
  `stock_quantity` int(11) DEFAULT -1, -- -1 for unlimited
  `purchases_count` int(11) DEFAULT 0,
  `active` tinyint(1) DEFAULT 1,
  `sort_order` int(11) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_category` (`category_id`),
  KEY `idx_active` (`active`),
  FOREIGN KEY (`category_id`) REFERENCES `shop_categories`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Shop item commands (SOAP commands to execute when item is purchased)
CREATE TABLE `shop_item_commands` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `item_id` int(11) NOT NULL,
  `command_template` text NOT NULL,
  `execution_order` int(11) DEFAULT 0,
  `description` varchar(255) DEFAULT NULL,
  `active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_item` (`item_id`),
  KEY `idx_order` (`execution_order`),
  FOREIGN KEY (`item_id`) REFERENCES `shop_items`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Shop transactions (purchase history)
CREATE TABLE `shop_transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `account_id` int(11) NOT NULL,
  `character_guid` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `quantity` int(11) DEFAULT 1,
  `price_paid` bigint(20) NOT NULL,
  `character_name` varchar(12) NOT NULL,
  `status` enum('pending','completed','failed','refunded') DEFAULT 'pending',
  `transaction_date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_date` timestamp NULL DEFAULT NULL,
  `notes` text,
  PRIMARY KEY (`id`),
  KEY `idx_account` (`account_id`),
  KEY `idx_character` (`character_guid`),
  KEY `idx_item` (`item_id`),
  KEY `idx_status` (`status`),
  KEY `idx_date` (`transaction_date`),
  FOREIGN KEY (`item_id`) REFERENCES `shop_items`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Insert default categories
INSERT INTO `shop_categories` (`name`, `description`, `icon`, `sort_order`) VALUES
('Mounts', 'Epic mounts and rare riding companions', 'mount_icon.png', 1),
('Services', 'Character services like race change, faction change, etc.', 'service_icon.png', 2),
('Gear Sets', 'Complete armor and weapon sets', 'gear_icon.png', 3),
('Items', 'Individual weapons, armor, and accessories', 'item_icon.png', 4),
('Consumables', 'Potions, food, and other consumable items', 'consumable_icon.png', 5);

-- Insert some example shop items
INSERT INTO `shop_items` (`category_id`, `name`, `description`, `price_gold`, `item_type`, `item_data`) VALUES
(1, 'Swift Spectral Tiger', 'Rare spectral tiger mount with 310% speed', 1000000, 'mount', '{"item_id": 49284, "spell_id": 42777}'),
(1, 'Ashes of Al\'ar', 'Legendary phoenix mount from Tempest Keep', 500000, 'mount', '{"item_id": 32458, "spell_id": 40192}'),
(2, 'Race Change', 'Change your character\'s race', 250000, 'service', '{"service_type": "race_change"}'),
(2, 'Faction Change', 'Change your character\'s faction', 300000, 'service', '{"service_type": "faction_change"}'),
(3, 'Tier 6 Warrior Set', 'Complete Destroyer Armor set for Warriors', 150000, 'gear_set', '{"items": [30974, 30975, 30976, 30977, 30978]}'),
(4, 'Shadowmourne', 'Legendary two-handed axe', 750000, 'item', '{"item_id": 49623}');

-- Insert example commands for the shop items
-- Commands use placeholders: {{character_name}}, {{quantity}}

-- Swift Spectral Tiger commands
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(1, 'learn spell 42777 {{character_name}}', 1, 'Learn Spectral Tiger mount spell'),
(1, 'send items {{character_name}} "Shop Purchase" "Your Swift Spectral Tiger mount from the shop!" 49284:1', 2, 'Send mount item');

-- Ashes of Al'ar commands  
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(2, 'learn spell 40192 {{character_name}}', 1, 'Learn Ashes of Al\'ar mount spell'),
(2, 'send items {{character_name}} "Shop Purchase" "Your Ashes of Al\'ar mount from the shop!" 32458:1', 2, 'Send mount item');

-- Race Change service
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(3, 'send mail {{character_name}} "Race Change Service" "You have purchased a race change service. Please contact a GM to apply this change. Include your desired race in your ticket."', 1, 'Send race change notification');

-- Faction Change service
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(4, 'send mail {{character_name}} "Faction Change Service" "You have purchased a faction change service. Please contact a GM to apply this change. Include your desired faction in your ticket."', 1, 'Send faction change notification');

-- Tier 6 Warrior Set commands
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(5, 'send items {{character_name}} "Shop Purchase" "Your Tier 6 Warrior Set from the shop!" 30974:1', 1, 'Send Destroyer Helmet'),
(5, 'send items {{character_name}} "Shop Purchase" "Your Tier 6 Warrior Set from the shop!" 30975:1', 2, 'Send Destroyer Shoulderpads'),
(5, 'send items {{character_name}} "Shop Purchase" "Your Tier 6 Warrior Set from the shop!" 30976:1', 3, 'Send Destroyer Chestguard'),
(5, 'send items {{character_name}} "Shop Purchase" "Your Tier 6 Warrior Set from the shop!" 30977:1', 4, 'Send Destroyer Gauntlets'),
(5, 'send items {{character_name}} "Shop Purchase" "Your Tier 6 Warrior Set from the shop!" 30978:1', 5, 'Send Destroyer Legguards');

-- Shadowmourne commands
INSERT INTO `shop_item_commands` (`item_id`, `command_template`, `execution_order`, `description`) VALUES
(6, 'send items {{character_name}} "Shop Purchase" "Your legendary Shadowmourne from the shop!" 49623:1', 1, 'Send Shadowmourne weapon');