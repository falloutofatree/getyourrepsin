import { useState, useCallback } from "react";
import { Text, Badge, Button, InlineStack, BlockStack } from "@shopify/polaris";
import type { Product } from "../types";
import { resolvePrice } from "../lib/utils/price-resolver";
import { formatMoney } from "../lib/utils/format";
import { VariantSelector } from "./VariantSelector";

interface ProductCardProps {
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

export function ProductCard({
  product,
  priceMap,
  currencyCode,
  onAddToCart,
}: ProductCardProps) {
  const [expanded, setExpanded] = useState(false);

  const firstVariant = product.variants.nodes[0];
  const hasMultipleVariants = product.variants.nodes.length > 1;
  const isOutOfStock = false;

  const priceMapObj = new Map(Object.entries(priceMap));
  const displayPrice = firstVariant
    ? resolvePrice(firstVariant.id, firstVariant.price, priceMapObj)
    : "0.00";

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const imageUrl = product.featuredImage?.url;
  const imageAlt = product.featuredImage?.altText ?? product.title;

  return (
    <div className="rep-portal-product-card">
      {imageUrl ? (
        <img
          className="rep-portal-product-card__image"
          src={imageUrl}
          alt={imageAlt}
          loading="lazy"
        />
      ) : (
        <div className="rep-portal-empty-image">&#128722;</div>
      )}
      <div className="rep-portal-product-card__body">
        <BlockStack gap="200">
          <p className="rep-portal-product-card__title">{product.title}</p>
          <InlineStack gap="200" blockAlign="center">
            <span className="rep-portal-product-card__price">
              {formatMoney(displayPrice, currencyCode)}
            </span>
            {hasMultipleVariants && (
              <Text as="span" variant="bodySm" tone="subdued">
                {`${product.variants.nodes.length} variants`}
              </Text>
            )}
          </InlineStack>
          <InlineStack gap="200" />
          <Button
            onClick={toggleExpand}
            disabled={isOutOfStock}
            fullWidth
          >
            {expanded ? "Close" : isOutOfStock ? "Out of Stock" : "Select"}
          </Button>
        </BlockStack>
      </div>
      {expanded && !isOutOfStock && (
        <VariantSelector
          product={product}
          priceMap={priceMap}
          currencyCode={currencyCode}
          onAddToCart={onAddToCart}
        />
      )}
    </div>
  );
}
