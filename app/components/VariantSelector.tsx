import { useState, useMemo, useCallback } from "react";
import {
  Select,
  TextField,
  Button,
  InlineStack,
  BlockStack,
  Text,
} from "@shopify/polaris";
import type { Product, ProductVariant } from "../types";
import { resolvePrice } from "../lib/utils/price-resolver";
import { formatMoney } from "../lib/utils/format";

interface VariantSelectorProps {
  product: Product;
  priceMap: Record<string, string>;
  currencyCode: string;
  onAddToCart: (item: {
    variantId: string;
    productId: string;
    productTitle: string;
    variantTitle: string;
    sku: string;
    quantity: number;
    price: string;
    imageUrl: string;
  }) => void;
}

export function VariantSelector({
  product,
  priceMap,
  currencyCode,
  onAddToCart,
}: VariantSelectorProps) {
  const variants = product.variants.nodes;
  const hasMultipleVariants = variants.length > 1;
  const priceMapObj = useMemo(() => new Map(Object.entries(priceMap)), [priceMap]);

  const [selectedVariantId, setSelectedVariantId] = useState(variants[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");

  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === selectedVariantId) ?? variants[0],
    [variants, selectedVariantId]
  );

  const resolvedPrice = selectedVariant
    ? resolvePrice(selectedVariant.id, selectedVariant.price, priceMapObj)
    : "0.00";

  const variantOptions = useMemo(
    () =>
      variants.map((v) => ({
        label: v.title === "Default Title" ? "Default" : v.title,
        value: v.id,
      })),
    [variants]
  );

  const maxQuantity = undefined;

  const handleAdd = useCallback(() => {
    if (!selectedVariant) return;
    let qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1) return;

    onAddToCart({
      variantId: selectedVariant.id,
      productId: product.id,
      productTitle: product.title,
      variantTitle: selectedVariant.title,
      sku: selectedVariant.sku ?? "",
      quantity: qty,
      price: resolvedPrice,
      imageUrl:
        selectedVariant.image?.url ??
        product.featuredImage?.url ??
        "",
    });

    setQuantity("1");
  }, [selectedVariant, quantity, resolvedPrice, product, onAddToCart, maxQuantity]);

  const isVariantOutOfStock = false;

  const variantImageUrl =
    selectedVariant?.image?.url ?? product.featuredImage?.url;
  const variantImageAlt =
    selectedVariant?.image?.altText ?? selectedVariant?.title ?? product.title;

  return (
    <div className="rep-portal-variant-selector">
      <BlockStack gap="300">
        {variantImageUrl && (
          <img
            className="rep-portal-variant-image"
            src={variantImageUrl}
            alt={variantImageAlt}
            loading="lazy"
          />
        )}
        {hasMultipleVariants && (
          <Select
            label="Variant"
            options={variantOptions}
            value={selectedVariantId}
            onChange={setSelectedVariantId}
          />
        )}
        <InlineStack gap="300" blockAlign="end">
          <div style={{ width: 80 }}>
            <TextField
              label="Qty"
              type="number"
              value={quantity}
              onChange={setQuantity}
              min={1}
              max={maxQuantity}
              autoComplete="off"
            />
          </div>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {formatMoney(resolvedPrice, currencyCode)}
          </Text>
          {selectedVariant?.sku && (
            <Text as="span" variant="bodySm" tone="subdued">
              SKU: {selectedVariant.sku}
            </Text>
          )}
        </InlineStack>
        {isVariantOutOfStock && (
          <Text as="p" variant="bodySm" tone="critical">
            This variant is out of stock
          </Text>
        )}
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={isVariantOutOfStock}
          fullWidth
        >
          Add to Cart
        </Button>
      </BlockStack>
    </div>
  );
}
