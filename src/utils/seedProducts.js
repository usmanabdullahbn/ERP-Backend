require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

// All profiles from Skypen and Turkprofil Karachi Ex pricelists.
// costPrice = White Without Gasket (Rs./ft) — the supplier purchase price.
// salePrice starts equal to costPrice; update to your selling rates.
// unit = ft (all profiles sold per foot, standard length 19 ft).

const products = [
  // ─── SKYPEN — OPAL 60 ───────────────────────────────────────────────────
  { sku: 'SP-601.1',   name: 'Openable Frame 60mm',          category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 328,  salePrice: 328 },
  { sku: 'SP-602.1',   name: 'Inward Window Sash',           category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 383,  salePrice: 383 },
  { sku: 'SP-602.4',   name: 'Inward Door Sash 100mm',       category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 467,  salePrice: 467 },
  { sku: 'SP-603.1',   name: 'Outward Window Sash',          category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 384,  salePrice: 384 },
  { sku: 'SP-604.1',   name: 'Openable Mullion OPAL',        category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 370,  salePrice: 370 },
  { sku: 'SP-602.5',   name: 'Flush Door Sash',              category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 345,  salePrice: 345 },
  { sku: 'SP-8804.1',  name: 'Flush Door Mullion',           category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 263,  salePrice: 263 },
  { sku: 'SP-605.1',   name: 'Openable Beading 5mm',         category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 97,   salePrice: 97  },
  { sku: 'SP-605.3',   name: 'Openable Beading 12mm',        category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 102,  salePrice: 102 },
  { sku: 'SP-609.8',   name: 'Fixed Panel 150mm',            category: 'Skypen - OPAL 60',    unit: 'ft', costPrice: 271,  salePrice: 271 },

  // ─── SKYPEN — ROYAL 60 ──────────────────────────────────────────────────
  { sku: 'SP-609.1',   name: 'Fixed Panel',                  category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 196,  salePrice: 196 },
  { sku: 'SP-609.2',   name: 'Bay Post Adaptor',             category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 534,  salePrice: 534 },
  { sku: 'SP-601.2',   name: 'Frame Royal 3 Chamber 60mm',   category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 342,  salePrice: 342 },
  { sku: 'SP-601.4',   name: 'Openable Frame 70/60mm',       category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 364,  salePrice: 364 },
  { sku: 'SP-603.3',   name: 'Outward Window/Door Sash',     category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 407,  salePrice: 407 },
  { sku: 'SP-604.3',   name: 'Openable Mullion ROYAL',       category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 382,  salePrice: 382 },
  { sku: 'SP-604.5',   name: 'Openable Mullion 70/60mm',     category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 402,  salePrice: 402 },
  { sku: 'SP-605.12',  name: 'Openable Beading 5mm (Royal)', category: 'Skypen - ROYAL 60',   unit: 'ft', costPrice: 98,   salePrice: 98  },

  // ─── SKYPEN — CRYSTAL 80 ────────────────────────────────────────────────
  { sku: 'SP-801.1',   name: 'Sliding Frame 80mm',           category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 411,  salePrice: 411 },
  { sku: 'SP-801.2',   name: 'Sliding Fixed Frame 80mm',     category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 293,  salePrice: 293 },
  { sku: 'SP-801.3',   name: 'Sliding Frame 80mm (B)',       category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 377,  salePrice: 377 },
  { sku: 'SP-802.1',   name: 'Small Window Sash 55mm',       category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 246,  salePrice: 246 },
  { sku: 'SP-802.2',   name: 'Large Window Sash 66mm',       category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 276,  salePrice: 276 },
  { sku: 'SP-802.3',   name: 'Sliding Door Sash 90mm',       category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 451,  salePrice: 451 },
  { sku: 'SP-802.4',   name: 'Window Sash 60mm',             category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 261,  salePrice: 261 },
  { sku: 'SP-804.1',   name: 'Sliding Sash Mullion',         category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 212,  salePrice: 212 },
  { sku: 'SP-804.3',   name: 'Screen Sash Mullion',          category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 139,  salePrice: 139 },
  { sku: 'SP-805.1',   name: 'Sliding Beading Round 5mm',    category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 60,   salePrice: 60  },
  { sku: 'SP-805.4',   name: 'Sliding Beading 16mm',         category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 40,   salePrice: 40  },
  { sku: 'SP-805.12',  name: 'Sliding Beading 5mm',          category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 62,   salePrice: 62  },
  { sku: 'SP-806.1',   name: 'Screen Sash 45mm',             category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 138,  salePrice: 138 },
  { sku: 'SP-806.3',   name: 'Screen Sash 52mm',             category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 156,  salePrice: 156 },
  { sku: 'SP-809.1',   name: 'Interlock',                    category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 65,   salePrice: 65  },
  { sku: 'SP-809.5',   name: 'In Line Adapter',              category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 279,  salePrice: 279 },
  { sku: 'SP-809.8',   name: 'Interlock 88 to 80',          category: 'Skypen - CRYSTAL 80', unit: 'ft', costPrice: 102,  salePrice: 102 },

  // ─── SKYPEN — DIAMOND 88 ────────────────────────────────────────────────
  { sku: 'SP-8801.1',  name: 'Sliding Frame 88mm',           category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 467,  salePrice: 467 },
  { sku: 'SP-8802.2',  name: 'Large Window Sash 68mm',       category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 326,  salePrice: 326 },
  { sku: 'SP-8802.3',  name: 'Sliding Door Sash 92mm',       category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 490,  salePrice: 490 },
  { sku: 'SP-8805.1',  name: 'Sliding Glass Beading 5mm',    category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 68,   salePrice: 68  },
  { sku: 'SP-8805.4',  name: 'Sliding Glass Beading 20mm',   category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 44,   salePrice: 44  },
  { sku: 'SP-8807.1',  name: 'Interlock (Diamond 88)',       category: 'Skypen - DIAMOND 88', unit: 'ft', costPrice: 65,   salePrice: 65  },

  // ─── SKYPEN — PREMIUM 92 ────────────────────────────────────────────────
  // 801.4 is the new frame unique to this series; sliding sashes are shared with CRYSTAL 80
  { sku: 'SP-801.4',   name: 'Sliding Frame 92mm',           category: 'Skypen - PREMIUM 92', unit: 'ft', costPrice: 421,  salePrice: 421 },
  { sku: 'SP-8806.2',  name: 'Sliding Netting Sash 50mm',    category: 'Skypen - PREMIUM 92', unit: 'ft', costPrice: 210,  salePrice: 210 },

  // ─── SKYPEN — EXCLUSIVE 101 ─────────────────────────────────────────────
  { sku: 'SP-8801.4',  name: 'Sliding Frame 101mm',          category: 'Skypen - EXCLUSIVE 101', unit: 'ft', costPrice: 473, salePrice: 473 },

  // ─── SKYPEN — AUXILIARY ─────────────────────────────────────────────────
  { sku: 'SP-109.1',   name: 'Georgian Bar',                 category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 39,   salePrice: 39  },
  { sku: 'SP-109.2',   name: 'Frame Connector',              category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 118,  salePrice: 118 },
  { sku: 'SP-109.6',   name: 'Bay Post Pipe',                category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 600,  salePrice: 600 },
  { sku: 'SP-109.7',   name: 'T-Closing / Small Border Profile', category: 'Skypen - Auxiliary', unit: 'ft', costPrice: 90, salePrice: 90 },
  { sku: 'SP-109.8',   name: 'Large Border Profile',         category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 256,  salePrice: 256 },
  { sku: 'SP-109.12',  name: 'Louver',                       category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 163,  salePrice: 163 },
  { sku: 'SP-109.16',  name: 'Universal Corner Pipe',        category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 1137, salePrice: 1137 },
  { sku: 'SP-109.17',  name: 'Universal Connector',          category: 'Skypen - Auxiliary',  unit: 'ft', costPrice: 104,  salePrice: 104 },

  // ─── TURKPROFIL — OPAL 60 ───────────────────────────────────────────────
  { sku: 'TP-601.1',   name: 'Openable Frame 60mm',          category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 313, salePrice: 313 },
  { sku: 'TP-601.5',   name: 'Small Openable Frame 60mm',    category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 287, salePrice: 287 },
  { sku: 'TP-602.1',   name: 'Inward Window Sash',           category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 370, salePrice: 370 },
  { sku: 'TP-602.4',   name: 'Inward Door Sash 100mm',       category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 443, salePrice: 443 },
  { sku: 'TP-603.1',   name: 'Outward Window Sash',          category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 368, salePrice: 368 },
  { sku: 'TP-604.1',   name: 'Openable Mullion OPAL',        category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 353, salePrice: 353 },
  { sku: 'TP-605.1',   name: 'Openable Beading 5mm',         category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 91,  salePrice: 91  },
  { sku: 'TP-606.1',   name: 'Openable Screen Sash',         category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 164, salePrice: 164 },
  { sku: 'TP-609.1',   name: 'Fixed Panel',                  category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 185, salePrice: 185 },
  { sku: 'TP-609.8',   name: 'Fixed Panel 150mm',            category: 'Turkprofil - OPAL 60',    unit: 'ft', costPrice: 247, salePrice: 247 },

  // ─── TURKPROFIL — ROYAL 60 ──────────────────────────────────────────────
  { sku: 'TP-601.2',   name: 'Frame Royal 3 Chamber 60mm',   category: 'Turkprofil - ROYAL 60',   unit: 'ft', costPrice: 313, salePrice: 313 },
  { sku: 'TP-603.3',   name: 'Outward Window/Door Sash',     category: 'Turkprofil - ROYAL 60',   unit: 'ft', costPrice: 379, salePrice: 379 },
  { sku: 'TP-605.12',  name: 'Openable Beading 5mm (Royal)', category: 'Turkprofil - ROYAL 60',   unit: 'ft', costPrice: 98,  salePrice: 98  },

  // ─── TURKPROFIL — FLUSH DOOR ─────────────────────────────────────────────
  { sku: 'TP-602.5',   name: 'Flush Door Sash',              category: 'Turkprofil - Flush Door', unit: 'ft', costPrice: 331, salePrice: 331 },
  { sku: 'TP-602.6',   name: 'Flush Door 112mm',             category: 'Turkprofil - Flush Door', unit: 'ft', costPrice: 288, salePrice: 288 },
  { sku: 'TP-8805.4',  name: 'Flush Door Beading',           category: 'Turkprofil - Flush Door', unit: 'ft', costPrice: 41,  salePrice: 41  },

  // ─── TURKPROFIL — 70mm SLIDING SERIES ───────────────────────────────────
  { sku: 'TP-701.1',   name: '70mm Sliding Frame',           category: 'Turkprofil - 70mm Sliding', unit: 'ft', costPrice: 305, salePrice: 305 },
  { sku: 'TP-702.1',   name: '70mm Sliding Series Sash',     category: 'Turkprofil - 70mm Sliding', unit: 'ft', costPrice: 190, salePrice: 190 },
  { sku: 'TP-709.1',   name: 'Interlock (70mm)',             category: 'Turkprofil - 70mm Sliding', unit: 'ft', costPrice: 48,  salePrice: 48  },

  // ─── TURKPROFIL — CRYSTAL 80 ─────────────────────────────────────────────
  { sku: 'TP-801.1',   name: 'Sliding Frame 80mm',           category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 390, salePrice: 390 },
  { sku: 'TP-801.3',   name: 'Sliding Frame 80mm (B)',       category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 361, salePrice: 361 },
  { sku: 'TP-802.1',   name: 'Small Window Sash 55mm',       category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 229, salePrice: 229 },
  { sku: 'TP-802.2',   name: 'Large Window Sash 66mm',       category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 260, salePrice: 260 },
  { sku: 'TP-802.4',   name: 'Window Sash 60mm',             category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 248, salePrice: 248 },
  { sku: 'TP-804.1',   name: 'Sliding Sash Mullion',         category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 213, salePrice: 213 },
  { sku: 'TP-805.1',   name: 'Sliding Beading Round 5mm',    category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 57,  salePrice: 57  },
  { sku: 'TP-805.4',   name: 'Sliding Beading 16mm',         category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 38,  salePrice: 38  },
  { sku: 'TP-805.12',  name: 'Sliding Beading 5mm',          category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 62,  salePrice: 62  },
  { sku: 'TP-806.1',   name: 'Screen Sash 45mm',             category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 131, salePrice: 131 },
  { sku: 'TP-809.1',   name: 'Interlock',                    category: 'Turkprofil - CRYSTAL 80', unit: 'ft', costPrice: 61,  salePrice: 61  },

  // ─── TURKPROFIL — AUXILIARY ──────────────────────────────────────────────
  { sku: 'TP-109.1',   name: 'Georgian Bar',                 category: 'Turkprofil - Auxiliary',  unit: 'ft', costPrice: 42,  salePrice: 42  },
  { sku: 'TP-109.7',   name: 'T-Closing / Small Border Profile', category: 'Turkprofil - Auxiliary', unit: 'ft', costPrice: 106, salePrice: 106 },
];

async function run() {
  await connectDB();
  console.log('[seed] Connected.');

  let created = 0;
  let skipped = 0;

  for (const p of products) {
    const result = await Product.updateOne(
      { sku: p.sku },
      { $setOnInsert: { ...p, type: 'STOCK', taxRate: 0, reorderLevel: 0, isActive: true } },
      { upsert: true }
    );
    if (result.upsertedCount) {
      created++;
      console.log(`  [+] ${p.sku} — ${p.name}`);
    } else {
      skipped++;
    }
  }

  console.log(`\n[seed] Done. Created: ${created}  |  Already existed (skipped): ${skipped}`);
  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});
