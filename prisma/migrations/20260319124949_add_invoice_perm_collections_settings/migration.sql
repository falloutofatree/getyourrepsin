-- CreateTable
CREATE TABLE "FilterableCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "numericId" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StaffInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "canSendInvoice" BOOLEAN NOT NULL DEFAULT false,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_StaffInfo" ("email", "firstName", "id", "lastName", "lastSeen", "shop") SELECT "email", "firstName", "id", "lastName", "lastSeen", "shop" FROM "StaffInfo";
DROP TABLE "StaffInfo";
ALTER TABLE "new_StaffInfo" RENAME TO "StaffInfo";
CREATE INDEX "StaffInfo_shop_idx" ON "StaffInfo"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FilterableCollection_shop_idx" ON "FilterableCollection"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "FilterableCollection_shop_collectionId_key" ON "FilterableCollection"("shop", "collectionId");

-- CreateIndex
CREATE INDEX "AppSettings_shop_idx" ON "AppSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key_key" ON "AppSettings"("shop", "key");
