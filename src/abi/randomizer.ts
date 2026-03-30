import { BODY_ARMORS, CHEST_RIG_ARMORS, CHEST_RIGS, HEADSETS, HELMETS, MAPS, WEAPONS, type AbiItem } from './data'

export type AbiLoadout = {
  map: AbiItem
  helmet: AbiItem
  armor: AbiItem
  chestRig?: AbiItem
  headset: AbiItem
  weapon: AbiItem
}

function pickOne(list: AbiItem[]): AbiItem {
  if (!list.length) return { name: 'Desconhecido' }
  const idx = Math.floor(Math.random() * list.length)
  return list[idx]
}

export function rollLoadout(sharedMap?: AbiItem): AbiLoadout {
  const useChestRig = Math.random() < 0.5
  const armor = useChestRig ? pickOne(CHEST_RIG_ARMORS) : pickOne(BODY_ARMORS)
  const chestRig = useChestRig ? undefined : pickOne(CHEST_RIGS)
  return {
    map: sharedMap ?? pickOne(MAPS),
    helmet: pickOne(HELMETS),
    armor,
    chestRig,
    headset: pickOne(HEADSETS),
    weapon: pickOne(WEAPONS)
  }
}
