/**
 * Service factory.
 * Single entry point — routes ask for `getServices(actor)` and get all services
 * wired with the same Supabase admin client.
 */
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Actor } from './base.service';
import { ProductsService } from './products.service';
import { ImagesService } from './images.service';
import { InventoryService } from './inventory.service';
import { PlatformMappingsService } from './platform-mappings.service';
import { CategoriesService } from './categories.service';
import { SearchService } from './search.service';
import { ValidationIssuesService } from './validation-issues.service';

export type Services = {
  products: ProductsService;
  images: ImagesService;
  inventory: InventoryService;
  platforms: PlatformMappingsService;
  categories: CategoriesService;
  search: SearchService;
  issues: ValidationIssuesService;
};

export function getServices(actor: Actor): Services {
  const db = createAdminSupabaseClient();
  return {
    products: new ProductsService(db, actor),
    images: new ImagesService(db, actor),
    inventory: new InventoryService(db, actor),
    platforms: new PlatformMappingsService(db, actor),
    categories: new CategoriesService(db, actor),
    search: new SearchService(db, actor),
    issues: new ValidationIssuesService(db, actor),
  };
}

export { ServiceError } from './base.service';
export type { Actor } from './base.service';
